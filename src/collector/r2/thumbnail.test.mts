import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { S3Client } from "@aws-sdk/client-s3";
import { buildCgiUrl, type CgiRequest } from "../cgi.mts";
import { readR2Config } from "./config.mts";
import {
  extractThumbnail,
  maxJpegBytes,
  readThumbnailSource,
  sha256,
} from "./source.mts";
import { createR2Store } from "./storage.mts";
import { refreshCameraThumbnail, thumbnailKey } from "./thumbnail.mts";

const source = { kind: "movcnt", mode: "latest" } as const;
const contentType = "multipart/form-data; boundary=fixture";
const jpeg = Buffer.from([0xff, 0xd8, 0, 0x80, 0xff, 0xd9]);
const otherJpeg = Buffer.from([0xff, 0xd8, 9, 0xfe, 0xff, 0xd9]);
const csv = Buffer.from(
  `20260101,0000,20260101,0100,01:00,+09:00,OUT\r\n${"1,0,1,0,6,7\r\n".repeat(8)}`,
);
const csvPart = {
  name: "mov_obj_cnt_latest.csv",
  type: "text/plain",
  bytes: csv,
};
const jpegPart = { name: "index_latest.jpg", type: "image/jpeg", bytes: jpeg };

function multipart(
  ...parts: Array<{ name: string; type?: string; bytes: Buffer }>
) {
  return Buffer.concat([
    ...parts.flatMap(({ name, type, bytes }) => [
      Buffer.from(
        `--fixture\r\nContent-Disposition: form-data; name="data"; filename="${name}"\r\n${type ? `Content-Type:${type}\r\n` : ""}Content-Length:${bytes.length}\r\n\r\n`,
      ),
      bytes,
      Buffer.from("\r\n"),
    ]),
    Buffer.from("--fixture--\r\n"),
  ]);
}

async function temp(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "ipro-r2-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function serve(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

const acquiredAtUtc = "2026-01-01T01:03:04.000Z";
async function capture(
  runtime: string,
  camera: "food" | "island",
  response: Buffer,
  run = "run-01",
) {
  const folder = join(runtime, "goal3-b", camera, run);
  await mkdir(folder, { recursive: true });
  const stem = join(folder, "movcnt_latest");
  await writeFile(`${stem}.bin`, response);
  await writeFile(
    `${stem}.meta.json`,
    JSON.stringify({
      cameraId: camera,
      ...source,
      fetchedAt: acquiredAtUtc,
      contentType,
      boundary: "fixture",
      httpStatus: 200,
      byteLength: response.length,
    }),
  );
  return `${stem}.bin`;
}

test("reuses Multipart parsing for JPEG-first and CSV-first responses with byte identity", () => {
  for (const raw of [
    multipart(csvPart, jpegPart),
    multipart(jpegPart, csvPart),
  ]) {
    const result = extractThumbnail(raw, source, contentType);
    assert.equal(result.status, "image");
    assert.ok(result.image.equals(jpeg));
    assert.equal(result.sha256, sha256(jpeg));
    assert.equal(result.sourceStartUtc, "2026-01-01T00:00:00.000Z");
    assert.equal(result.sourceEndUtc, "2026-01-01T01:00:00.000Z");
  }
  const ambiguous = extractThumbnail(
    multipart(csvPart, { ...jpegPart, name: "other.jpg" }),
    source,
    contentType,
  );
  assert.equal(ambiguous.status, "image");
  assert.equal(ambiguous.sourceStartUtc, undefined);
});

test("uses the existing real island heatmap capture if available", async (t) => {
  const base = resolve("runtime/goal1/island");
  const dirs = await readdir(base, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs.filter((entry) => entry.isDirectory())) {
    const body = await readFile(
      join(base, dir.name, "heatmap_mov_latest_comp.bin"),
    ).catch(() => null);
    if (!body) continue;
    const header = body.indexOf("\r\nContent-Type:image/jpeg\r\n");
    assert.ok(header >= 0, "Saved JPEG header missing");
    const start = body.indexOf("\r\n\r\n", header) + 4;
    const end = body.indexOf("\r\n--myboundary", start);
    assert.ok(start > 4 && end > start, "Saved JPEG boundaries missing");
    const result = extractThumbnail(
      body,
      { kind: "heatmap_mov", mode: "latest_comp" },
      "multipart/form-data; boundary=myboundary",
    );
    assert.equal(result.status, "image");
    assert.ok(
      result.image.equals(body.subarray(start, end)),
      "Extracted JPEG differs from saved camera bytes",
    );
    return;
  }
  t.skip("No local image-bearing i-PRO capture is available.");
});

test("rejects missing, multiple, empty, oversized or malformed JPEGs without misclassifying No Data", () => {
  assert.deepEqual(
    extractThumbnail(Buffer.from("No Data.\r\n"), source, "text/plain"),
    { status: "no_data", noDataCode: 0 },
  );
  assert.deepEqual(
    extractThumbnail(Buffer.from("No Data(1)."), source, "text/plain"),
    { status: "no_data", noDataCode: 1 },
  );
  assert.throws(
    () => extractThumbnail(Buffer.from("No Data(3)."), source, "text/plain"),
    { code: "camera_data" },
  );
  assert.throws(
    () => extractThumbnail(multipart(csvPart), source, contentType),
    { code: "image_count" },
  );
  assert.throws(
    () =>
      extractThumbnail(
        multipart(csvPart, jpegPart, { ...jpegPart, name: "second.jpg" }),
        source,
        contentType,
      ),
    { code: "image_count" },
  );
  assert.throws(
    () =>
      extractThumbnail(
        multipart(csvPart, jpegPart),
        source,
        "multipart/form-data; boundary=wrong",
      ),
    { code: "invalid_response" },
  );
  assert.throws(
    () =>
      extractThumbnail(
        multipart(csvPart, { ...jpegPart, bytes: Buffer.alloc(0) }),
        source,
        contentType,
      ),
    { code: "invalid_response" },
  );
  assert.throws(
    () =>
      extractThumbnail(
        multipart(csvPart, {
          ...jpegPart,
          bytes: Buffer.from([0xff, 0xd8, 0, 0]),
        }),
        source,
        contentType,
      ),
    { code: "invalid_response" },
  );
  assert.throws(
    () =>
      extractThumbnail(
        multipart(csvPart, { ...jpegPart, type: "image/png" }),
        source,
        contentType,
      ),
    { code: "invalid_response" },
  );
  assert.throws(
    () =>
      extractThumbnail(
        multipart(csvPart, { ...jpegPart, type: undefined }),
        source,
        contentType,
      ),
    { code: "image_type" },
  );
  const huge = Buffer.alloc(maxJpegBytes + 1);
  huge.writeUInt16BE(0xffd8, 0);
  huge.writeUInt16BE(0xffd9, huge.length - 2);
  assert.throws(
    () =>
      extractThumbnail(
        multipart(csvPart, { ...jpegPart, bytes: huge }),
        source,
        contentType,
      ),
    { code: "image_size" },
  );
});

const account = "a".repeat(32);
const bucket = "private-thumbnail-fixture";
const credentials = {
  accessKeyId: "fake-access-key",
  secretAccessKey: "fake-secret-key",
};

test("restricts camera keys, thumbnail CGI modes and S3 endpoint settings", () => {
  assert.equal(thumbnailKey("food"), "cameras/food/thumbnail.jpg");
  assert.equal(thumbnailKey("island"), "cameras/island/thumbnail.jpg");
  assert.throws(() => thumbnailKey("../other/jpg"), { code: "camera_id" });
  assert.deepEqual(readThumbnailSource("food", {}), source);
  assert.deepEqual(
    readThumbnailSource("island", {
      IPRO_ISLAND_THUMBNAIL_KIND: "heatmap_mov",
    }),
    { kind: "heatmap_mov", mode: "latest_comp" },
  );
  assert.throws(
    () =>
      readThumbnailSource("food", { IPRO_FOOD_THUMBNAIL_KIND: "movcnt_info" }),
    { code: "config" },
  );
  const camera = new URL("http://127.0.0.1");
  const url = buildCgiUrl(camera, source);
  assert.equal(
    Buffer.from(url.searchParams.get("s_appData") ?? "", "base64").toString(),
    "{{appMethod:csv},{kind:movcnt},{mode:latest}}",
  );
  assert.throws(
    () =>
      buildCgiUrl(camera, {
        kind: "movcnt",
        mode: "range",
      } as unknown as CgiRequest),
    /Unsupported/,
  );
  assert.throws(
    () =>
      buildCgiUrl(camera, {
        kind: "movcnt",
        mode: "multi",
        window: {},
      } as unknown as CgiRequest),
    /Unsupported/,
  );

  const env = {
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_R2_BUCKET: bucket,
    CLOUDFLARE_R2_ACCESS_KEY_ID: credentials.accessKeyId,
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  };
  assert.equal(
    readR2Config(env)?.endpoint,
    `https://${account}.r2.cloudflarestorage.com`,
  );
  assert.equal(
    readR2Config({
      ...env,
      CLOUDFLARE_R2_ENDPOINT: `https://${account}.eu.r2.cloudflarestorage.com`,
    })?.credentials.accessKeyId,
    credentials.accessKeyId,
  );
  for (const endpoint of [
    `http://${account}.r2.cloudflarestorage.com`,
    "https://localhost",
    `https://${account}.r2.cloudflarestorage.com.evil.tld`,
  ]) {
    assert.throws(
      () => readR2Config({ ...env, CLOUDFLARE_R2_ENDPOINT: endpoint }),
      { code: "config" },
    );
  }
  assert.equal(
    readR2Config(
      { CLOUDFLARE_API_TOKEN: "unused", CLOUDFLARE_ACCOUNT_ID: account },
      true,
    ),
    undefined,
  );
});

interface ObjectState {
  bytes: Buffer;
  etag: string;
  headers: Record<string, string>;
}

async function chunks(request: IncomingMessage) {
  const collection: Buffer[] = [];
  for await (const chunk of request) collection.push(chunk);
  return Buffer.concat(collection);
}

async function mockR2(t: TestContext) {
  const calls: { method: string; key: string; condition?: string }[] = [];
  const objects = new Map<string, ObjectState>();
  const delayed: number[] = [];
  const errors: Record<string, Array<{ status: number; code?: string }>> = {};
  const flags = { corruptGet: false };
  let version = 0;
  const endpoint = await serve(t, async (request, response) => {
    const method = request.method ?? "";
    const name = new URL(request.url ?? "/", "http://localhost").pathname;
    const key = name.slice(bucket.length + 2);
    calls.push({
      method,
      key,
      condition:
        request.headers["if-match"] ?? request.headers["if-none-match"],
    });
    const forced = errors[method]?.shift();
    if (forced) {
      response.writeHead(forced.status, { "Content-Type": "application/xml" });
      response.end(
        `<Error><Code>${forced.code ?? "InternalError"}</Code><Message>secret must stay redacted</Message></Error>`,
      );
      return;
    }
    const previous = objects.get(key);
    if (method === "PUT") {
      if (
        previous
          ? request.headers["if-match"] !== previous.etag
          : request.headers["if-none-match"] !== "*"
      ) {
        response.writeHead(412);
        response.end("<Error><Code>PreconditionFailed</Code></Error>");
        return;
      }
      const bytes = await chunks(request);
      const etag = `"version-${++version}"`;
      const headers = {
        "Content-Length": String(bytes.length),
        "Content-Type": String(request.headers["content-type"]),
        "Cache-Control": String(request.headers["cache-control"]),
        "Last-Modified": "Thu, 01 Jan 2026 01:04:00 GMT",
        ETag: etag,
        ...Object.fromEntries(
          Object.entries(request.headers).filter(
            ([name, value]) =>
              name.startsWith("x-amz-meta-") && typeof value === "string",
          ),
        ),
      };
      objects.set(key, { bytes, etag, headers });
      response.writeHead(200, { ETag: etag });
      response.end();
      return;
    }
    if (!previous) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (method === "GET" && request.headers["if-match"] !== previous.etag) {
      response.writeHead(412);
      response.end("<Error><Code>PreconditionFailed</Code></Error>");
      return;
    }
    response.writeHead(200, previous.headers);
    if (method === "GET")
      response.end(flags.corruptGet ? otherJpeg : previous.bytes);
    else response.end();
  });
  const client = new S3Client({
    endpoint,
    credentials,
    region: "auto",
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const store = createR2Store(
    { endpoint, bucket, credentials },
    client,
    async (ms) => {
      delayed.push(ms);
    },
  );
  t.after(() => store.close());
  return { calls, objects, delayed, errors, flags, store };
}

test("HEAD 404 creates a fixed key, PUT/HEAD/GET verify original bytes, and identical JPEG leaves the object unchanged", async (t) => {
  const mock = await mockR2(t);
  const runtime = await temp(t);
  const saved = await capture(runtime, "food", multipart(csvPart, jpegPart));
  const options = { env: {}, runtime, store: mock.store, sourceFile: saved };
  const dry = await refreshCameraThumbnail("food", {
    ...options,
    dryRun: true,
  });
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.plan, "create");
  assert.deepEqual(
    mock.calls.map(({ method }) => method),
    ["HEAD"],
  );
  mock.calls.length = 0;

  const uploaded = await refreshCameraThumbnail("food", options);
  assert.equal(uploaded.status, "uploaded");
  assert.equal(uploaded.image?.sha256, sha256(jpeg));
  assert.equal(uploaded.image?.retrievedAtUtc, acquiredAtUtc);
  assert.equal(uploaded.lastModifiedUtc, "2026-01-01T01:04:00.000Z");
  assert.deepEqual(
    mock.calls.map(({ method }) => method),
    ["HEAD", "PUT", "HEAD", "GET"],
  );
  assert.equal(mock.calls[1].condition, "*");
  const object = mock.objects.get(thumbnailKey("food"));
  assert.ok(object);
  assert.ok(object.bytes.equals(jpeg));
  assert.equal(object.headers["Content-Type"], "image/jpeg");
  assert.equal(object.headers["Cache-Control"], "private, no-cache");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(object.headers).filter(([key]) =>
        key.startsWith("x-amz-meta-"),
      ),
    ),
    {
      "x-amz-meta-camera-id": "food",
      "x-amz-meta-sha256": sha256(jpeg),
      "x-amz-meta-retrieved-at-utc": acquiredAtUtc,
      "x-amz-meta-source-kind": "movcnt",
      "x-amz-meta-source-mode": "latest",
      "x-amz-meta-source-start-utc": "2026-01-01T00:00:00.000Z",
      "x-amz-meta-source-end-utc": "2026-01-01T01:00:00.000Z",
    },
  );
  mock.calls.length = 0;
  const repeated = await refreshCameraThumbnail("food", options);
  assert.equal(repeated.status, "unchanged");
  assert.equal(repeated.lastModifiedUtc, uploaded.lastModifiedUtc);
  assert.deepEqual(
    mock.calls.map(({ method }) => method),
    ["HEAD", "GET"],
  );
  assert.equal(mock.objects.get(thumbnailKey("food"))?.etag, object.etag);

  const newer = await capture(
    runtime,
    "food",
    multipart(csvPart, { ...jpegPart, bytes: otherJpeg }),
    "run-02",
  );
  assert.equal(
    (await refreshCameraThumbnail("food", { ...options, sourceFile: newer }))
      .status,
    "uploaded",
  );
  assert.equal(mock.calls.at(-3)?.condition, object.etag);
  assert.equal(mock.objects.size, 1);
  assert.ok(mock.objects.get(thumbnailKey("food"))?.bytes.equals(otherJpeg));
});

test("denied or unavailable HEAD cannot trigger PUT, transient status retries are bounded, PUT errors are classified", async (t) => {
  const mock = await mockR2(t);
  const runtime = await temp(t);
  const saved = await capture(runtime, "island", multipart(csvPart, jpegPart));
  const options = { env: {}, runtime, store: mock.store, sourceFile: saved };

  mock.errors.HEAD = [{ status: 403 }];
  const denied = await refreshCameraThumbnail("island", options);
  assert.equal(denied.status, "failed");
  assert.equal(denied.error.code, "r2_permissions");
  assert.deepEqual(
    mock.calls.map(({ method }) => method),
    ["HEAD"],
  );
  mock.calls.length = 0;
  mock.errors.HEAD = [{ status: 503 }, { status: 503 }, { status: 503 }];
  const exhausted = await refreshCameraThumbnail("island", options);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.error.code, "r2_upstream");
  assert.deepEqual(
    mock.calls.map(({ method }) => method),
    ["HEAD", "HEAD", "HEAD"],
  );
  assert.deepEqual(mock.delayed, [250, 500]);

  mock.errors.PUT = [{ status: 404, code: "NoSuchBucket" }];
  const missing = await refreshCameraThumbnail("island", options);
  assert.equal(missing.status, "failed");
  assert.equal(missing.error.code, "r2_bucket_missing");
  assert.equal(mock.objects.size, 0);
  mock.calls.length = 0;
  mock.errors.HEAD = [{ status: 429 }];
  mock.errors.PUT = [{ status: 503 }];
  assert.equal(
    (await refreshCameraThumbnail("island", options)).status,
    "uploaded",
  );
  assert.deepEqual(
    mock.calls.map(({ method }) => method),
    ["HEAD", "HEAD", "PUT", "PUT", "HEAD", "GET"],
  );
  assert.ok(
    !JSON.stringify([denied, exhausted, missing]).includes(
      "secret must stay redacted",
    ),
  );
});

test("verification failure is uncertain and rechecking the same archive can confirm it without rewriting", async (t) => {
  const mock = await mockR2(t);
  const runtime = await temp(t);
  const saved = await capture(runtime, "food", multipart(jpegPart, csvPart));
  const options = { env: {}, runtime, store: mock.store, sourceFile: saved };
  mock.flags.corruptGet = true;
  const result = await refreshCameraThumbnail("food", options);
  assert.equal(result.status, "uncertain");
  assert.equal(result.error.code, "r2_verify");
  assert.equal(result.lastModifiedUtc, undefined);
  mock.flags.corruptGet = false;
  assert.equal(
    (await refreshCameraThumbnail("food", options)).status,
    "unchanged",
  );
  const puts = mock.calls.filter(({ method }) => method === "PUT").length;
  const noJpeg = await capture(
    runtime,
    "food",
    multipart(csvPart),
    "run-no-image",
  );
  const noData = await capture(
    runtime,
    "food",
    Buffer.from("No Data."),
    "run-no-data",
  );
  assert.equal(
    (await refreshCameraThumbnail("food", { ...options, sourceFile: noJpeg }))
      .status,
    "failed",
  );
  assert.equal(
    (await refreshCameraThumbnail("food", { ...options, sourceFile: noData }))
      .status,
    "no_data",
  );
  assert.equal(
    mock.calls.filter(({ method }) => method === "PUT").length,
    puts,
  );
  assert.ok(mock.objects.get(thumbnailKey("food"))?.bytes.equals(jpeg));
  const wrong = await refreshCameraThumbnail("island", options);
  assert.equal(wrong.status, "failed");
  assert.equal(wrong.error.code, "source_file");
  const differentSource = await refreshCameraThumbnail("food", {
    ...options,
    env: { IPRO_FOOD_THUMBNAIL_KIND: "heatmap_loi" },
  });
  assert.equal(differentSource.status, "failed");
  assert.equal(differentSource.error.code, "source_file");
});

const collector = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));
async function cli(
  cwd: string,
  script: string,
  args: string[],
  settings: Record<string, string> = {},
) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("IPRO_") || key.startsWith("CLOUDFLARE_"))
      delete env[key];
  }
  return promisify(execFile)(
    process.execPath,
    ["--experimental-strip-types", collector(script), ...args],
    { cwd, env: { ...env, ...settings } },
  );
}

test("CLI requires an explicit camera, continues after a camera error and supports offline dry-run without D1 or R2", async (t) => {
  const workspace = await temp(t);
  const runtime = join(workspace, "runtime");
  const image = multipart(jpegPart, csvPart);
  const endpoint = await serve(t, (request, response) => {
    if (
      request.headers.authorization ===
      `Basic ${Buffer.from("food:camera-secret").toString("base64")}`
    ) {
      response.writeHead(401);
      response.end("private camera response");
    } else {
      response.writeHead(200, { "Content-Type": contentType });
      response.end(image);
    }
  });
  const env: Record<string, string> = {};
  for (const id of ["FOOD", "ISLAND"]) {
    Object.assign(env, {
      [`IPRO_${id}_NAME`]: id,
      [`IPRO_${id}_USER`]: id.toLowerCase(),
      [`IPRO_${id}_PASSWORD`]: "camera-secret",
      [`IPRO_${id}_BASE_URL`]: endpoint,
    });
  }
  await assert.rejects(cli(workspace, "./cli.mts", ["--dry-run"], env), {
    code: 2,
  });
  await assert.rejects(
    cli(workspace, "./cli.mts", ["--camera", "all", "--dry-run"], env),
    (error: Error) => {
      const output = error as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      return (
        output.code === 1 &&
        /food failed.*camera_auth/.test(output.stderr) &&
        /island dry_run.*plan=not_checked/.test(output.stdout) &&
        /dry_run=1 failed=1/.test(output.stdout) &&
        !/camera-secret|private camera response/.test(
          output.stdout + output.stderr,
        )
      );
    },
  );
  const [run] = await readdir(join(runtime, "goal3-b", "island"));
  const archive = join(runtime, "goal3-b", "island", run, "movcnt_latest.bin");
  assert.ok(
    (
      await readFile(join(runtime, "goal3-b", "island", run, "thumbnail.jpg"))
    ).equals(jpeg),
  );
  const repeated = await cli(workspace, "./cli.mts", [
    "--camera",
    "island",
    "--dry-run",
    "--source-file",
    archive,
  ]);
  assert.match(repeated.stdout, new RegExp(`sha256=${sha256(jpeg)}`));
});

test("backfill, sync, d1:import and parse never request image CGI or use R2", async (t) => {
  const workspace = await temp(t);
  const requests: Array<{ kind: string; mode: string }> = [];
  const endpoint = await serve(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const payload = Buffer.from(
      url.searchParams.get("s_appData") ?? "",
      "base64",
    ).toString();
    const kind = /\{kind:(\w+)\}/.exec(payload)?.[1] ?? "";
    const mode = /\{mode:(\w+)\}/.exec(payload)?.[1] ?? "";
    requests.push({ kind, mode });
    if (mode === "range") {
      response.end("DataFrom=2026010100(UTC)\r\nDataUntil=2026010100(UTC)\r\n");
      return;
    }
    response.writeHead(200, { "Content-Type": contentType });
    response.end(multipart(csvPart));
  });
  const guard = join(workspace, "network-guard.mjs");
  const sentinel = join(workspace, "unexpected-network");
  await writeFile(
    guard,
    `import https from "node:https"; import { syncBuiltinESMExports } from "node:module"; import { appendFileSync } from "node:fs"; const fail = () => { appendFileSync(${JSON.stringify(sentinel)}, "external network"); throw new Error("External network disabled."); }; https.request = fail; syncBuiltinESMExports(); globalThis.fetch = fail;`,
  );
  const env = {
    IPRO_FOOD_NAME: "fixture",
    IPRO_FOOD_USER: "test-user",
    IPRO_FOOD_PASSWORD: "test-pass",
    IPRO_FOOD_BASE_URL: endpoint,
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_R2_BUCKET: bucket,
    CLOUDFLARE_R2_ACCESS_KEY_ID: credentials.accessKeyId,
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    NODE_OPTIONS: `--import=${guard}`,
  };
  await cli(workspace, "../d1/cli.mts", ["migrate", "--local"], env);
  await cli(
    workspace,
    "../d1/cli.mts",
    ["backfill", "--local", "--camera", "food"],
    env,
  );
  await cli(
    workspace,
    "../d1/cli.mts",
    ["sync", "--local", "--camera", "food"],
    env,
  );
  assert.deepEqual(
    requests.map(({ mode }) => mode),
    ["range", "multi", "range", "multi", "latest"],
  );
  assert.ok(requests.every(({ kind }) => kind === "movcnt_info"));
  const cameraCalls = requests.length;
  await cli(workspace, "../parse/cli.mts", [], env);
  await cli(workspace, "../d1/cli.mts", ["import", "--local"], env);
  assert.equal(requests.length, cameraCalls);
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
});
