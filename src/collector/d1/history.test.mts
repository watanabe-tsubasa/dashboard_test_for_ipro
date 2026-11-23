import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { collectHistory } from "./collect.mts";
import {
  type Database,
  d1Database,
  migrate,
  readD1Config,
  type Statement,
} from "./database.mts";
import { importGoal2 } from "./import.mts";
import { localDatabase } from "./local.mts";
import {
  dailyWindows,
  readBounds,
  retainedWindow,
  windowForRequest,
} from "./planner.mts";
import { prepareMeasurement } from "./records.mts";
import { completedCoverage, persistMeasurements } from "./repository.mts";
import { readTargets } from "./targets.mts";

const time = (value: string) => `2026-01-${value}:00.000Z`;
const utc = time("01T00:00");
const nextHour = time("01T01:00");
const fullPeriod = { startUtc: utc, endUtc: nextHour, intervalMinutes: 60 };
const baseLine = {
  schemaVersion: 1,
  cameraId: "island",
  kind: "linecross",
  acquiredAtUtc: time("01T02:00"),
  period: fullPeriod,
  source: { requestKind: "movcnt_info", requestMode: "latest" },
  lines: Array.from({ length: 8 }, (_, index) => ({
    lineNumber: index + 1,
    countIn: index + 1,
    countOut: 1,
  })),
};

const zeros: number[][] = Array.from({ length: 64 }, () =>
  Array<number>(64).fill(0),
);
const grid = zeros.map((row) => [...row]);
grid[1][2] = 102;
function heatmap(kind: "heatmap_mov" | "heatmap_loi", grid: number[][]) {
  return {
    schemaVersion: 1,
    cameraId: "island",
    kind,
    period: fullPeriod,
    acquiredAtUtc: time("01T02:00"),
    grid,
    source: { requestKind: `${kind}_info`, requestMode: "latest_comp" },
  };
}

async function memory(t: TestContext) {
  const db = await localDatabase(":memory:");
  t.after(() => db.close());
  await migrate(db);
  return db;
}

async function root(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ipro-d1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("configures history kinds per camera and allows all kinds on food", () => {
  assert.deepEqual(readTargets("food", {}), ["linecross"]);
  assert.deepEqual(readTargets("island", {}), [
    "linecross",
    "heatmap_mov",
    "heatmap_loi",
  ]);
  assert.deepEqual(
    readTargets("food", {
      IPRO_FOOD_HISTORY_KINDS: "heatmap_mov, linecross, heatmap_loi, linecross",
    }),
    ["heatmap_mov", "linecross", "heatmap_loi"],
  );
  assert.deepEqual(readTargets("food", { IPRO_FOOD_HISTORY_KINDS: "" }), []);
  assert.throws(
    () => readTargets("food", { IPRO_FOOD_HISTORY_KINDS: "camera-secret" }),
    {
      message: "Invalid history kind in IPRO_FOOD_HISTORY_KINDS.",
    },
  );
});

test("plans the reported range in UTC days, preserves both bounds and includes the final stored hour", () => {
  const range = { dataFromUtc: utc, dataUntilUtc: time("03T02:00") };
  const now = Date.parse(time("04T00:00"));
  const full = retainedWindow(range, {}, now);
  assert.deepEqual(full, { startUtc: utc, endUtc: time("03T03:00") });
  assert.deepEqual(dailyWindows(full), [
    { startUtc: utc, endUtc: time("02T00:00") },
    { startUtc: time("02T00:00"), endUtc: time("03T00:00") },
    { startUtc: time("03T00:00"), endUtc: time("03T03:00") },
  ]);
  assert.deepEqual(
    retainedWindow(range, readBounds("2026-01-02T08:30+09:00"), now),
    {
      startUtc: time("01T23:30"),
      endUtc: time("03T03:00"),
    },
  );
  assert.deepEqual(
    retainedWindow(range, readBounds(undefined, "2026-01-02T09:30+09:00"), now),
    {
      startUtc: utc,
      endUtc: time("02T00:30"),
    },
  );
  assert.equal(
    retainedWindow(range, readBounds("2026-01-05T00:00Z"), now),
    undefined,
  );
  assert.equal(
    retainedWindow(range, {}, Date.parse("2026-01-03T02:32:48Z"))?.endUtc,
    time("03T02:32"),
  );
  assert.throws(
    () => readBounds("2026-01-03T08:00+09:00", "2026-01-02T22:00Z"),
    /later/,
  );
  const [first] = dailyWindows(full);
  assert.deepEqual(windowForRequest(first, full), {
    startUtc: utc,
    endUtc: time("02T01:00"),
  });
});

test("sync includes older coverage gaps, the overlap and new time", () => {
  const window = { startUtc: utc, endUtc: time("07T00:00") };
  const ceiling = [
    { startUtc: utc, endUtc: time("02T00:00") },
    { startUtc: time("03T00:00"), endUtc: time("05T12:00") },
    { startUtc: time("05T12:00"), endUtc: time("06T00:00") },
  ];
  assert.deepEqual(
    dailyWindows(window, ceiling).map(({ startUtc }) => startUtc),
    [time("02T00:00"), time("05T00:00"), time("06T00:00")],
  );
  assert.equal(dailyWindows(window, []).length, 6);
});

test("UPSERT ranks progress and finality, logs newer complete corrections, and makes repeats no-ops", async (t) => {
  const db = await memory(t);
  const logs: string[] = [];
  const save = (record: unknown) =>
    persistMeasurements(db, [prepareMeasurement(record)], (message) =>
      logs.push(message),
    );
  const withEnd = (
    end: string,
    count: number,
    acquiredAtUtc = time("01T02:00"),
  ) => ({
    ...baseLine,
    acquiredAtUtc,
    period: { ...fullPeriod, endUtc: end },
    lines: baseLine.lines.map((line) => ({
      ...line,
      countIn: line.lineNumber === 1 ? count : line.countIn,
    })),
  });
  const fragment = withEnd(time("01T00:10"), 2);
  const laterFragment = withEnd(time("01T00:45"), 4, time("01T01:55"));
  const complete = withEnd(nextHour, 6);
  const correction = withEnd(nextHour, 8, time("01T03:00"));
  assert.equal((await save(fragment)).inserted, 8);
  assert.equal((await save(laterFragment)).updated, 8);
  assert.equal((await save(fragment)).unchanged, 8);
  assert.equal((await save(complete)).updated, 8);
  assert.equal((await save(laterFragment)).unchanged, 8);
  assert.equal((await save(complete)).unchanged, 8);
  const before = await db.batch([
    { sql: "SELECT updated_at_utc FROM linecross_hourly ORDER BY line_no" },
  ]);
  assert.equal(
    (await save({ ...complete, acquiredAtUtc: time("01T04:00") })).unchanged,
    8,
  );
  assert.deepEqual(
    await db.batch([
      { sql: "SELECT updated_at_utc FROM linecross_hourly ORDER BY line_no" },
    ]),
    before,
  );
  assert.equal((await save(correction)).corrected, 1);
  assert.match(logs.join("\n"), /corrected_complete island linecross line=1/);
  assert.equal((await save(complete)).unchanged, 8);
  const [lines] = await db.batch([
    { sql: "SELECT * FROM linecross_hourly ORDER BY line_no" },
  ]);
  assert.equal(lines.length, 8);
  assert.equal(lines[0].expected_end_utc, nextHour);
  assert.equal(lines[0].measured_until_utc, nextHour);
  assert.equal(lines[0].is_complete, 1);
  assert.equal(lines[0].count_in, 8);
  assert.equal(lines[0].source_captured_at_utc, correction.acquiredAtUtc);
  assert.deepEqual(
    await completedCoverage(db, "island", "linecross", {
      startUtc: utc,
      endUtc: nextHour,
    }),
    [{ startUtc: utc, endUtc: nextHour }],
  );
});

test("independent cameras, intervals and map kinds retain zero/nonzero grids without collisions", async (t) => {
  const db = await memory(t);
  const records = [
    baseLine,
    { ...baseLine, cameraId: "food" },
    {
      ...baseLine,
      period: { ...fullPeriod, intervalMinutes: 15, endUtc: time("01T00:15") },
    },
    heatmap("heatmap_mov", grid),
    heatmap("heatmap_loi", zeros),
  ];
  const write = () =>
    persistMeasurements(
      db,
      records.map((record) => prepareMeasurement(record)),
      () => {},
    );
  assert.equal((await write()).inserted, 26);
  assert.equal((await write()).unchanged, 26);
  const [maps, lines, enabled] = await db.batch([
    {
      sql: "SELECT kind, grid_json, max_value, nonzero_cells FROM heatmaps_hourly ORDER BY kind",
    },
    { sql: "SELECT COUNT(*) AS n FROM linecross_hourly" },
    {
      sql: "SELECT COUNT(*) AS n FROM camera_lines WHERE include_in_visitors=1",
    },
  ]);
  assert.equal(lines[0].n, 24);
  assert.equal(enabled[0].n, 0);
  assert.equal(maps[0].kind, "heatmap_loi");
  assert.equal(maps[0].max_value, 0);
  assert.equal(maps[0].nonzero_cells, 0);
  assert.equal(maps[1].kind, "heatmap_mov");
  assert.equal(maps[1].max_value, 102);
  assert.equal(maps[1].nonzero_cells, 1);
  assert.deepEqual(JSON.parse(String(maps[1].grid_json)), grid);
});

test("rejects invalid measurements and accepts the observed sub-minute timestamp difference", () => {
  assert.throws(
    () =>
      prepareMeasurement({
        ...baseLine,
        lines: [{ lineNumber: 1, countIn: -1 }],
      }),
    /eight/,
  );
  assert.throws(
    () =>
      prepareMeasurement({
        ...baseLine,
        lines: [
          { ...baseLine.lines[0], countIn: -1 },
          ...baseLine.lines.slice(1),
        ],
      }),
    /Invalid IN/,
  );
  assert.throws(
    () =>
      prepareMeasurement({
        ...baseLine,
        period: { ...fullPeriod, intervalMinutes: 15 },
      }),
    /out of bounds/,
  );
  assert.throws(
    () => prepareMeasurement(baseLine, Date.parse("2025-01-01T00:00Z")),
    /out of bounds/,
  );
  assert.throws(
    () => prepareMeasurement(heatmap("heatmap_loi", zeros.slice(0, 63))),
    /64 rows/,
  );
  assert.throws(
    () =>
      prepareMeasurement(
        heatmap("heatmap_loi", [zeros[0].slice(0, 63), ...zeros.slice(1)]),
      ),
    /64 columns/,
  );
  assert.throws(
    () =>
      prepareMeasurement({
        ...baseLine,
        source: {
          ...baseLine.source,
          requestMode: "multi",
          requestWindow: { startUtc: time("01T00:30"), endUtc: nextHour },
        },
      }),
    /outside/,
  );
  assert.equal(
    prepareMeasurement({
      ...baseLine,
      acquiredAtUtc: "2026-01-01T00:44:59.065Z",
      period: { ...fullPeriod, endUtc: time("01T00:45") },
    }).complete,
    0,
  );
});

test("D1 REST binds parameters, retries transient HTTP errors, and redacts API failures including partial batch", async () => {
  const config = {
    account: "1".repeat(32),
    database: "11111111-1111-4111-8111-111111111111",
    token: "synthetic-private-token",
  };
  const timings: number[] = [];
  let calls = 0;
  const send: typeof fetch = async (url, options) => {
    assert.equal(
      String(url),
      `https://api.cloudflare.com/client/v4/accounts/${config.account}/d1/database/${config.database}/query`,
    );
    assert.equal(
      new Headers(options?.headers).get("Authorization"),
      `Bearer ${config.token}`,
    );
    assert.deepEqual(JSON.parse(String(options?.body)), {
      batch: [{ sql: "SELECT ? AS n", params: ["42"] }],
    });
    calls++;
    if (calls === 1)
      return new Response("", { status: 429, headers: { "Retry-After": "1" } });
    if (calls === 2) return new Response("", { status: 503 });
    return Response.json({
      success: true,
      errors: [],
      result: [{ success: true, results: [{ n: 42 }] }],
    });
  };
  const db = d1Database(config, send, async (ms) => {
    timings.push(ms);
  });
  assert.deepEqual(await db.batch([{ sql: "SELECT ? AS n", params: [42] }]), [
    [{ n: 42 }],
  ]);
  assert.deepEqual(timings, [1000, 500]);

  for (const [response, expected] of [
    [
      Response.json({ success: false, errors: [{ message: config.token }] }),
      /rejected the batch/,
    ],
    [
      Response.json({
        success: true,
        errors: [{ message: config.token }],
        result: [],
      }),
      /rejected the batch/,
    ],
    [
      Response.json({
        success: true,
        result: [{ success: true }, { success: false, error: config.token }],
      }),
      /statement 2/,
    ],
    [
      Response.json(
        {
          success: false,
          errors: [
            { code: 7500, message: `SQL syntax error: ${config.token}` },
          ],
        },
        { status: 500 },
      ),
      /HTTP 500/,
    ],
    [Response.json({ message: config.token }, { status: 403 }), /HTTP 403/],
  ] as const) {
    let attempts = 0;
    const broken = d1Database(
      config,
      async () => {
        attempts++;
        return response;
      },
      async () => {},
    );
    await assert.rejects(
      broken.batch([{ sql: "SELECT 1" }, { sql: "SELECT 2" }]),
      (error: Error) =>
        expected.test(error.message) && !error.message.includes(config.token),
    );
    assert.equal(attempts, 1);
  }
  assert.throws(
    () => readD1Config({ CLOUDFLARE_API_TOKEN: config.token }),
    (error: Error) => !error.message.includes(config.token),
  );

  let recovered = 0;
  const sqlite = await localDatabase(":memory:");
  try {
    const transport = d1Database(
      config,
      async (_url, options) => {
        if (++recovered === 1) {
          return Response.json(
            { success: false, errors: [{ code: 7429 }] },
            { status: 500 },
          );
        }
        const { batch } = JSON.parse(String(options?.body)) as {
          batch: Statement[];
        };
        assert.ok(
          batch.every(
            ({ params }) =>
              params?.every((param) => typeof param === "string") ?? true,
          ),
        );
        const rows = await sqlite.batch(batch);
        return Response.json({
          success: true,
          errors: [],
          result: rows.map((results) => ({ success: true, results })),
        });
      },
      async () => {},
    );
    await migrate(transport);
    assert.equal(recovered, 2);
    const measurements = [
      prepareMeasurement(baseLine),
      prepareMeasurement(heatmap("heatmap_mov", grid)),
    ];
    assert.equal(
      (await persistMeasurements(transport, measurements, () => {})).inserted,
      9,
    );
    assert.equal(
      (await persistMeasurements(transport, measurements, () => {})).unchanged,
      9,
    );
  } finally {
    sqlite.close();
  }
});

test("a failed write chunk does not block the next chunk and rerunning repairs it", async (t) => {
  const db = await memory(t);
  const measurements = [
    "01",
    "02",
    "03",
    "04",
    "05",
    "06",
    "07",
    "08",
    "09",
    "10",
    "11",
    "12",
    "13",
  ].map((day) =>
    prepareMeasurement({
      ...baseLine,
      acquiredAtUtc: time(`${day}T02:00`),
      period: {
        ...fullPeriod,
        startUtc: time(`${day}T00:00`),
        endUtc: time(`${day}T01:00`),
      },
    }),
  );
  let sent = 0;
  const faults: Database = {
    async batch(statements: readonly Statement[]) {
      assert.ok(statements.every(({ params }) => (params?.length ?? 0) <= 100));
      if (++sent === 1) throw new Error("Simulated D1 rejection");
      return db.batch(statements);
    },
  };
  const first = await persistMeasurements(faults, measurements, () => {});
  assert.equal(first.inserted, 8);
  assert.equal(first.failures, 1);
  assert.equal(first.unconfirmed, 96);
  const retry = await persistMeasurements(db, measurements, () => {});
  assert.equal(retry.inserted, 96);
  assert.equal(retry.unchanged, 8);
});

test("offline import reads only Goal2 manifests, excludes disabled kinds and dry run never writes", async (t) => {
  const directory = await root(t);
  const local = join(directory, "runtime", "goal2", "food", "test-run");
  await mkdir(local, { recursive: true });
  const manifest = join(local, "records.json");
  const data = JSON.stringify({
    schemaVersion: 1,
    cameraId: "food",
    status: "data",
    records: [
      { ...baseLine, cameraId: "food" },
      { ...heatmap("heatmap_mov", grid), cameraId: "food" },
    ],
  });
  await writeFile(manifest, data);
  const cli = fileURLToPath(new URL("./cli.mts", import.meta.url));
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--experimental-strip-types",
      cli,
      "import",
      "--local",
      "--dry-run",
      "--camera",
      "food",
    ],
    {
      cwd: directory,
      env: { ...process.env, IPRO_FOOD_HISTORY_KINDS: "linecross" },
    },
  );
  assert.match(result.stdout, /records=1 rows=8 disabled=1 inserted=0/);
  await assert.rejects(
    readFile(join(directory, "runtime", "goal3-a", "history.sqlite")),
    { code: "ENOENT" },
  );

  const db = await memory(t);
  const targets = [
    { cameraId: "food", kinds: readTargets("food", {}) },
  ] as const;
  assert.equal(
    await importGoal2(
      join(directory, "runtime", "goal2"),
      targets,
      db,
      () => {},
    ),
    0,
  );
  const [lines, maps] = await db.batch([
    { sql: "SELECT COUNT(*) AS n FROM linecross_hourly" },
    { sql: "SELECT COUNT(*) AS n FROM heatmaps_hourly" },
  ]);
  assert.equal(lines[0].n, 8);
  assert.equal(maps[0].n, 0);
  assert.equal(await readFile(manifest, "utf8"), data);
});

test("collection separates No Data and HTTP failures, continues across dates and cameras, then sync fills the gap", async (t) => {
  const directory = await root(t);
  let failDay = true;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const payload = Buffer.from(
      url.searchParams.get("s_appData") ?? "",
      "base64",
    ).toString();
    const isFood =
      request.headers.authorization ===
      `Basic ${Buffer.from("food:local-fixture").toString("base64")}`;
    requests.push(payload);
    if (payload.includes("mode:range")) {
      if (isFood)
        response.end(
          "DataFrom=2026010100(UTC)\r\nDataUntil=2026010200(UTC)\r\n",
        );
      else if (payload.includes("heatmap_loi")) {
        response.writeHead(401);
        response.end("sensitive fixture");
      } else response.end("No Data.\r\n");
    } else if (failDay && payload.includes("{date:1}")) {
      response.writeHead(500);
      response.end("sensitive fixture");
    } else {
      const day = payload.includes("{date:1}") ? "01" : "02";
      const body = `202601${day},0000,202601${day},0100,01:00,+09:00,OUT\r\n${"1,0,1,0,6,7\r\n".repeat(8)}`;
      response.writeHead(200, {
        "Content-Type": "multipart/form-data; boundary=verify",
      });
      response.end(
        `--verify\r\nContent-Disposition: form-data; filename="counts.csv"\r\nContent-Type:text/plain\r\nContent-Length:${Buffer.byteLength(body)}\r\n\r\n${body}\r\n--verify--\r\n`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = { ...process.env };
  for (const id of ["food", "island"]) {
    const prefix = `IPRO_${id.toUpperCase()}_`;
    env[`${prefix}NAME`] = id;
    env[`${prefix}USER`] = id;
    env[`${prefix}PASSWORD`] = "local-fixture";
    env[`${prefix}BASE_URL`] = `http://127.0.0.1:${address.port}`;
  }
  const db = await memory(t);
  const logs: string[] = [];
  const targets = [
    { cameraId: "food", kinds: readTargets("food", {}) },
    { cameraId: "island", kinds: readTargets("island", {}) },
  ] as const;
  const options = {
    bounds: {},
    runtime: directory,
    env,
    log: (message: string) => logs.push(message),
  };
  const forbidden: Database = {
    batch: async () => {
      assert.fail("Dry run must not write or query D1 on backfill");
    },
  };
  assert.equal(
    await collectHistory(targets, {
      ...options,
      dryRun: true,
      action: "backfill",
      db: forbidden,
    }),
    1,
  );
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.includes("mode:range")));
  assert.match(logs.join("\n"), /island heatmap_mov skipped \(range no_data/);
  assert.match(logs.join("\n"), /island heatmap_loi failed.*HTTP 401/);
  assert.doesNotMatch(logs.join("\n"), /sensitive fixture|local-fixture/);

  assert.equal(
    await collectHistory(targets, {
      ...options,
      dryRun: false,
      action: "backfill",
      db,
    }),
    1,
  );
  const query = [{ sql: "SELECT COUNT(*) AS n FROM linecross_hourly" }];
  assert.equal((await db.batch(query))[0][0].n, 8);
  failDay = false;
  for (let round = 0; round < 2; round++) {
    assert.equal(
      await collectHistory(targets.slice(0, 1), {
        ...options,
        bounds: readBounds(undefined, "2026-01-02T02:00Z"),
        dryRun: false,
        action: "sync",
        db,
      }),
      0,
    );
    assert.equal((await db.batch(query))[0][0].n, 16);
  }
});
