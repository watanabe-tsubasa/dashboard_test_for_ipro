import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ThumbnailError } from "../r2/failure.mts";
import { adminApi } from "./api.mts";
import { backfillBounds, readSubmission } from "./input.mts";
import { openJobs } from "./jobs.mts";
import { createRedactor } from "./redact.mts";
import { runJob } from "./run-job.mts";

const origin = "http://127.0.0.1:3000";
const host = "127.0.0.1:3000";
const sync = { operation: "sync", camera: "all" } as const;
const fixtureEnv = {
  ...process.env,
  IPRO_FOOD_NAME: "Fixture camera",
  IPRO_FOOD_BASE_URL: "http://192.168.30.40:8080",
  IPRO_FOOD_USER: "fixture-user",
  IPRO_FOOD_PASSWORD: "fixture-password",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
  CLOUDFLARE_API_TOKEN: "fixture-d1-token",
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: "",
  CLOUDFLARE_R2_ACCESS_KEY_ID: "",
  CLOUDFLARE_R2_BUCKET: "",
};

function req(
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(origin + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      host,
      ...(data === undefined
        ? {}
        : { origin, "content-type": "application/json" }),
      ...headers,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}

async function root(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ipro-admin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "jobs.sqlite") };
}

test("accepts only allowlisted operations and exact JST date bounds", () => {
  const now = Date.parse("2026-11-23T01:00:00Z");
  assert.deepEqual(readSubmission(sync, now), { request: sync });
  const valid = readSubmission(
    {
      operation: "backfill",
      camera: "food",
      from: "2026-11-21",
      to: "2026-11-21",
      dryRun: true,
    },
    now,
  );
  assert.ok("request" in valid && valid.request.operation === "backfill");
  const bounds = backfillBounds(valid.request);
  assert.equal(bounds.from, Date.parse("2026-11-20T15:00:00Z"));
  assert.equal(bounds.to, Date.parse("2026-11-21T15:00:00Z"));
  for (const bad of [
    { ...sync, camera: "food;touch" },
    { ...sync, path: "../../../etc/passwd" },
    { operation: "thumbnail", camera: "all" },
    { operation: "fetch", camera: "food" },
    { operation: "backfill", camera: "food" },
    { operation: "backfill", camera: "food", dryRun: "true" },
    { operation: "backfill", camera: "food", from: "2026-11-21", dryRun: true },
    {
      operation: "backfill",
      camera: "food",
      from: false,
      to: false,
      dryRun: true,
    },
    { ...valid.request, from: "2026-02-30" },
    { ...valid.request, to: "2026-11-20" },
    { ...valid.request, to: "2026-11-24" },
    { ...valid.request, from: "2022-01-01" },
  ])
    assert.throws(() => readSubmission(bad, now));
});

test("atomically queues one job and resumes state and bounded incremental logs from a new connection", async (t) => {
  const { file } = await root(t);
  const jobs = openJobs(file);
  const queued = jobs.enqueue(sync);
  assert.equal(queued.accepted, true);
  assert.equal(queued.job.state, "queued");
  const concurrent = openJobs(file);
  assert.equal(concurrent.enqueue(sync).accepted, false);
  assert.equal(concurrent.claim(queued.job.id)?.state, "running");
  jobs.append(queued.job.id, "plan");
  jobs.update(
    queued.job.id,
    { completedTargets: 1, totalTargets: 4 },
    {
      plans: [],
      targets: [],
      counts: {
        inserted: 0,
        updated: 0,
        unchanged: 8,
        corrected: 0,
        unconfirmed: 0,
        failures: 0,
        noData: 0,
        records: 1,
      },
    },
  );
  const first = concurrent.detail(queued.job.id);
  assert.equal(first?.job.progress?.completedTargets, 1);
  assert.equal(first?.job.report?.counts.unchanged, 8);
  assert.equal(first?.logs[0].message, "plan");
  for (let index = 0; index < 125; index++)
    jobs.append(queued.job.id, `line ${index}`);
  const second = concurrent.detail(queued.job.id, first?.cursor);
  assert.equal(second?.logs.length, 120);
  assert.equal(second.hasMore, true);
  assert.equal(concurrent.detail(queued.job.id, second.cursor)?.logs.length, 5);
  jobs.finish(queued.job.id, 0, null);
  assert.equal(concurrent.detail(queued.job.id)?.job.state, "succeeded");
  assert.equal(concurrent.active(), null);
  jobs.close();
  concurrent.close();
});

test("distinguishes a surviving worker from a dead or recycled PID and expires abandoned queues", async (t) => {
  const { file } = await root(t);
  let time = 200_000;
  let owner: string | null = "worker-1";
  const options = { clock: () => time, identity: () => owner };
  let jobs = openJobs(file, options);
  const first = jobs.enqueue(sync).job;
  jobs.claim(first.id, 7);
  jobs.close();
  time += 100_000;
  jobs = openJobs(file, options);
  assert.equal(jobs.active()?.id, first.id);
  owner = "other-process";
  assert.equal(jobs.active(), null);
  assert.equal(jobs.detail(first.id)?.job.state, "interrupted");
  const queued = jobs.enqueue(sync).job;
  time += 45_001;
  assert.equal(jobs.claim(queued.id), null);
  assert.equal(jobs.detail(queued.id)?.job.state, "interrupted");
  owner = null;
  const next = jobs.enqueue(sync).job;
  jobs.launchFailed(next.id);
  assert.equal(jobs.detail(next.id)?.job.state, "failed");
  assert.equal(jobs.detail(next.id)?.job.exitCode, 1);
  jobs.close();
});

test("API validates origin and body, accepts exactly one concurrent start, and retries matching failed input", async (t) => {
  const { file } = await root(t);
  const calls: string[] = [];
  const api = adminApi({
    env: fixtureEnv,
    open: () => openJobs(file),
    launch: async (id) => {
      calls.push(id);
    },
  });
  assert.equal(
    (
      await api.start(
        req("/api/collector/jobs", sync, { origin: "https://external.test" }),
      )
    ).status,
    403,
  );
  assert.equal(
    api.status(
      req("/api/collector/status", undefined, { host: "external.test" }),
    ).status,
    403,
  );
  assert.equal(
    (
      await api.start(
        req("/api/collector/jobs", sync, { "content-type": "text/plain" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await api.start(
        req("/api/collector/jobs", { ...sync, extra: "x".repeat(5000) }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await api.start(
        req("/api/collector/jobs", { operation: "thumbnail", camera: "food" }),
      )
    ).status,
    400,
  );
  const results = await Promise.all([
    api.start(req("/api/collector/jobs", sync)),
    api.start(req("/api/collector/jobs", sync)),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [202, 409]);
  const ids = await Promise.all(results.map((result) => result.json()));
  assert.equal(ids[0].jobId, ids[1].jobId);
  assert.deepEqual(calls, [ids[0].jobId]);
  assert.equal(
    (await api.detail(req("/api/collector/jobs/x"), ids[0].jobId).json()).job
      .state,
    "queued",
  );
  const jobs = openJobs(file);
  jobs.claim(ids[0].jobId);
  jobs.finish(ids[0].jobId, 1, "failure");
  jobs.close();
  const retry = await api.start(
    req("/api/collector/jobs", { retryOf: ids[0].jobId }),
  );
  assert.equal(retry.status, 202);
  assert.notEqual((await retry.json()).jobId, ids[0].jobId);
  assert.equal(
    (await api.list(req("/api/collector/jobs")).json()).jobs.length,
    2,
  );
});

test("status has no side-effect and redacts private endpoint and authentication values", async (t) => {
  const { file } = await root(t);
  const api = adminApi({
    env: { ...fixtureEnv, IPRO_FOOD_NAME: "192.168.30.40 fixture-password" },
    open: () => openJobs(file),
    launch: async () => {
      assert.fail("Unexpected worker");
    },
    image: async () => {
      assert.fail("Unexpected R2");
    },
    database: {
      batch: async () => {
        assert.fail("Unexpected D1");
      },
    },
  });
  const text = await api.status(req("/api/collector/status")).text();
  const status = JSON.parse(text);
  assert.equal(status.d1Configured, true);
  assert.equal(status.r2Configured, false);
  assert.deepEqual(status.cameras[0].kinds, ["linecross"]);
  assert.ok(!/192\.168|fixture-password|fixture-d1-token/.test(text));
  const safe = createRedactor({
    ...fixtureEnv,
    CLOUDFLARE_R2_ACCESS_KEY_ID: "fixture-r2-id",
  });
  const auth = Buffer.from("fixture-user:fixture-password").toString("base64");
  assert.ok(
    !safe(
      `auth Basic ${auth} http://192.168.30.40:8080 fixture-r2-id`,
    ).includes("fixture-r2-id"),
  );
  assert.ok(!safe(`auth Basic ${auth}`).includes(auth));
});

test("thumbnail API proxies the allowlisted image and returns safe errors for 404 or denied access", async () => {
  const api = adminApi({
    env: fixtureEnv,
    image: async (key, max) => {
      assert.ok(max > 0);
      if (key === "cameras/food/thumbnail.jpg")
        return {
          data: Buffer.from("image"),
          lastModifiedUtc: "2026-11-22T10:00:00.000Z",
        };
      throw new ThumbnailError("r2_not_found", "fixture secret");
    },
  });
  const image = await api.thumbnail(
    req("/api/collector/thumbnails/food"),
    "food",
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("cache-control"), "no-store");
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.equal(await image.text(), "image");
  assert.equal(
    (await api.thumbnail(req("/api/collector/thumbnails/../../x"), "../../x"))
      .status,
    404,
  );
  const missing = await api.thumbnail(
    req("/api/collector/thumbnails/island"),
    "island",
  );
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /fixture secret/);
  const restricted = adminApi({
    env: fixtureEnv,
    image: async () => {
      throw new ThumbnailError("r2_permissions", "fixture secret");
    },
  });
  assert.equal(
    (
      await restricted.thumbnail(
        req("/api/collector/thumbnails/island"),
        "island",
      )
    ).status,
    403,
  );
});

test("measurement summary uses only SELECT queries and preserves missing rows", async () => {
  const api = adminApi({
    env: fixtureEnv,
    database: {
      batch: async (statements) => {
        assert.ok(statements.every(({ sql }) => /^SELECT /.test(sql)));
        return [
          [
            {
              camera_id: "food",
              kind: "linecross",
              rows: 8,
              newest: "2026-01-01T02:00Z",
            },
          ],
          [],
        ];
      },
    },
  });
  const data = await (
    await api.measurements(req("/api/collector/measurements"))
  ).json();
  assert.deepEqual(data.island, { state: "ready", rows: [] });
  assert.equal(data.food.rows[0].rows, 8);
});

test("worker persists real range-derived plans, No Data, and safe failure with a loopback camera", async (t) => {
  const { file, directory } = await root(t);
  let response = "range";
  const camera = createServer((_request, outgoing) => {
    if (response === "range")
      outgoing.end("DataFrom=2026010100(UTC)\r\nDataUntil=2026010100(UTC)\r\n");
    else if (response === "no_data") outgoing.end("No Data.");
    else {
      outgoing.writeHead(401);
      outgoing.end("fixture-password");
    }
  });
  await new Promise<void>((resolve) => camera.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    camera.closeAllConnections();
    camera.close();
  });
  const address = camera.address();
  assert.ok(address && typeof address === "object");
  const env = {
    ...fixtureEnv,
    IPRO_FOOD_BASE_URL: `http://127.0.0.1:${address.port}`,
  };
  const jobs = openJobs(file);
  t.after(() => jobs.close());
  const action = {
    operation: "backfill",
    camera: "food",
    dryRun: true,
  } as const;
  const first = jobs.enqueue(action).job.id;
  assert.equal(await runJob(first, jobs, env, directory), 0);
  const planned = jobs.detail(first);
  assert.equal(planned?.job.report?.plans[0]?.multi, 1);
  assert.equal(planned?.job.progress?.completedTargets, 1);
  response = "no_data";
  const second = jobs.enqueue(action).job.id;
  assert.equal(await runJob(second, jobs, env, directory), 0);
  assert.equal(jobs.detail(second)?.job.report?.counts.noData, 1);
  response = "error";
  const third = jobs.enqueue(action).job.id;
  assert.equal(await runJob(third, jobs, env, directory), 1);
  const detail = jobs.detail(third);
  assert.equal(detail?.job.state, "failed");
  assert.ok(detail?.logs.some(({ message }) => message.includes("HTTP 401")));
  assert.doesNotMatch(JSON.stringify(detail), /fixture-password|127\.0\.0\.1/);
});
