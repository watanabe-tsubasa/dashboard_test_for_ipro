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
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildCgiUrl, type CgiRequest } from "./cgi.mts";
import { type CameraConfig, readCameraConfig } from "./config.mts";
import { historyQuery } from "./history.mts";
import { getCameraResponse, maxResponseBytes } from "./iproClient.mts";
import { createRunDirectory, newRunId, saveResponse } from "./rawStore.mts";

const credentials = {
  username: "local-test-user",
  password: "synthetic-password",
};
const range = { kind: "movcnt_info", mode: "range" } as const;
const rangeBody =
  "DataFrom=202611220900(UTC)\r\nDataUntil=202611221200(UTC)\r\n";
const boundary = "camera-test-boundary";
const contentType = `multipart/form-data; boundary="${boundary}"`;
const csvPart = `--${boundary}\r\nContent-Disposition: form-data; filename="counts.csv"\r\nContent-Type: text/plain\r\n\r\n1,2\r\n`;
const csvBody = Buffer.from(`${csvPart}--${boundary}\r\n`);
const withImage = Buffer.concat([
  Buffer.from(`${csvPart}--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),
  Buffer.from([0xff, 0xd8, 0x00, 0x80, 0xff, 0xd9]),
  Buffer.from(`\r\n--${boundary}\r\n`),
]);

function cameraEnv(id: string, url: URL) {
  const prefix = `IPRO_${id.toUpperCase()}`;
  return {
    [`${prefix}_NAME`]: `Camera ${id}`,
    [`${prefix}_BASE_URL`]: url.origin,
    [`${prefix}_USER`]: credentials.username,
    [`${prefix}_PASSWORD`]: credentials.password,
  };
}

function cameraAt(baseUrl: URL, timeoutMs = 2000): CameraConfig {
  return {
    id: "food",
    name: "Camera food",
    baseUrl,
    timeoutMs,
    ...credentials,
  };
}

async function mockCamera(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    if (server.listening) {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: new URL(`http://127.0.0.1:${address.port}`) };
}

async function temporaryDirectory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "ipro-goal1-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function runCli(cwd: string, ...args: string[]) {
  const cli = fileURLToPath(new URL("./cli.mts", import.meta.url));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("IPRO_")) {
      delete env[key];
    }
  }
  try {
    const result = await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", cli, ...args],
      { cwd, env },
    );
    return { code: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

async function writeEnv(directory: string, settings: Record<string, string>) {
  await writeFile(
    join(directory, ".env.local"),
    Object.entries(settings)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
}

test("validates both camera configurations independently", () => {
  const food = new URL("https://[::1]:8443");
  const island = new URL("http://127.0.0.1");
  const env = {
    ...cameraEnv("food", food),
    ...cameraEnv("island", island),
    IPRO_TIMEOUT_MS: "500",
  };
  assert.equal(
    readCameraConfig("food", env).camera?.baseUrl.origin,
    food.origin,
  );
  assert.equal(
    readCameraConfig("island", env).camera?.baseUrl.origin,
    island.origin,
  );
  assert.equal(readCameraConfig("food", env).camera?.timeoutMs, 500);

  for (const address of [
    "ftp://localhost",
    "http://user:secret@localhost",
    "http://@localhost",
    "http://localhost/path",
    "http://localhost/?",
    "http://localhost/#",
  ]) {
    const invalid = { ...env, IPRO_FOOD_BASE_URL: address };
    const { error } = readCameraConfig("food", invalid);
    assert.match(error ?? "", /IPRO_FOOD_BASE_URL/);
    assert.doesNotMatch(error ?? "", /secret/);
    assert.ok(readCameraConfig("island", invalid).camera);
  }
  assert.match(
    readCameraConfig("food", { ...env, IPRO_FOOD_PASSWORD: "" }).error ?? "",
    /IPRO_FOOD_PASSWORD/,
  );
  assert.match(
    readCameraConfig("food", { ...env, IPRO_FOOD_USER: "bad:user" }).error ??
      "",
    /Invalid Basic/,
  );
  assert.match(
    readCameraConfig("food", { ...env, IPRO_TIMEOUT_MS: "0" }).error ?? "",
    /IPRO_TIMEOUT_MS/,
  );
});

test("builds an encoded read-only CGI request and rejects invalid combinations", () => {
  const baseUrl = new URL("http://localhost");
  const url = buildCgiUrl(baseUrl, range);
  assert.equal(url.pathname, "/cgi-bin/adam.cgi");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    methodName: "sendDataToAdamApplication",
    appName: "iVmdApp",
    s_appDataType: "0",
    s_appData: Buffer.from(
      "{{appMethod:csv},{kind:movcnt_info},{mode:range}}",
    ).toString("base64"),
  });

  for (const request of [
    { kind: "movcnt_info", mode: "latest_comp" },
    { kind: "heatmap_mov", mode: "range" },
    { kind: "heatmap_loi_info", mode: "multi" },
    { kind: "toString", mode: "range" },
  ]) {
    assert.throws(
      () => buildCgiUrl(baseUrl, request as CgiRequest),
      /Unsupported CGI/,
    );
  }
});

test("sends Basic GET and saves multipart bytes including JPEG unchanged", async (t) => {
  let authorization: string | undefined;
  let method: string | undefined;
  const { url } = await mockCamera(t, (request, response) => {
    authorization = request.headers.authorization;
    method = request.method;
    response.writeHead(200, { "Content-Type": contentType });
    response.end(withImage);
  });
  const camera = cameraAt(url);
  const request = { kind: "heatmap_mov", mode: "latest_comp" } as const;
  const result = await getCameraResponse(camera, request);
  const token = Buffer.from(
    `${credentials.username}:${credentials.password}`,
  ).toString("base64");
  assert.ok(
    authorization === `Basic ${token}`,
    "expected the configured Basic credentials",
  );
  assert.equal(method, "GET");

  const root = await temporaryDirectory(t);
  const directory = await createRunDirectory(root, "food", newRunId());
  const saved = await saveResponse(
    directory,
    camera,
    request,
    result,
    new Date().toISOString(),
  );
  assert.equal(saved.result, "success");
  assert.equal(saved.boundary, boundary);
  assert.equal(saved.byteLength, withImage.length);
  assert.ok(saved.bodyPath);
  assert.deepEqual(await readFile(saved.bodyPath), withImage);
  const metadata = await readFile(saved.metadataPath, "utf8");
  assert.ok(
    !metadata.includes(token) && !metadata.includes(credentials.password),
  );

  const nextDirectory = await createRunDirectory(root, "food", newRunId());
  assert.notEqual(nextDirectory, directory);
  await assert.rejects(
    saveResponse(directory, camera, request, result, new Date().toISOString()),
    { code: "EEXIST" },
  );
  assert.deepEqual(await readFile(saved.bodyPath), withImage);
});

test("records 200 No Data variants and preserves ambiguous bodies", async (t) => {
  let responseBody = "";
  const { url } = await mockCamera(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(responseBody);
  });
  const root = await temporaryDirectory(t);
  const camera = cameraAt(url);
  for (const [text, outcome, error] of [
    ["No Data.", "no_data", "no_data"],
    ["No Data(1).", "no_data", "no_data_1"],
    ["No Data(2).", "no_data", "no_data_2"],
    ["No Data(3).", "unknown", "no_data_3"],
    ["<html>Sign in</html>", "unknown", "unexpected_body"],
    [rangeBody.trimEnd(), "success", undefined],
  ] as const) {
    responseBody = `${text}\r\n`;
    const result = await getCameraResponse(camera, range);
    const directory = await createRunDirectory(root, "food", newRunId());
    const saved = await saveResponse(
      directory,
      camera,
      range,
      result,
      new Date().toISOString(),
    );
    assert.equal(saved.httpStatus, 200);
    assert.equal(saved.result, outcome);
    assert.equal(saved.error?.type, error);
    assert.ok(saved.bodyPath);
    assert.equal(await readFile(saved.bodyPath, "utf8"), responseBody);
  }
});

test("distinguishes HTTP errors, timeout, connection failure and payload limits", async (t) => {
  let status = 401;
  const { server, url } = await mockCamera(t, (_request, response) => {
    if (status === 0) {
      response.writeHead(200);
      response.write("partial body");
    } else if (status === 201) {
      response.writeHead(200);
      response.end(Buffer.alloc(maxResponseBytes + 1));
    } else if (status === 202) {
      response.writeHead(200, { "Content-Length": maxResponseBytes + 1 });
      response.end();
    } else {
      response.writeHead(status, { Location: "/must-not-follow" });
      response.end("Synthetic error body");
    }
  });
  const root = await temporaryDirectory(t);
  const camera = cameraAt(url);
  for (const [code, type] of [
    [401, "authentication"],
    [403, "authentication"],
    [404, "not_found"],
    [500, "server_error"],
    [302, "http_status"],
  ] as const) {
    status = code;
    const directory = await createRunDirectory(root, "food", newRunId());
    const result = await getCameraResponse(camera, range);
    const saved = await saveResponse(
      directory,
      camera,
      range,
      result,
      new Date().toISOString(),
    );
    assert.equal(saved.result, "http_error");
    assert.equal(saved.httpStatus, code);
    assert.equal(saved.error?.type, type);
    assert.ok(saved.bodyPath);
    assert.equal(
      await readFile(saved.bodyPath, "utf8"),
      "Synthetic error body",
    );
  }
  for (const code of [201, 202]) {
    status = code;
    const response = await getCameraResponse(camera, range);
    assert.equal(response.error?.type, "response_too_large");
    assert.equal(response.body, null);
  }

  status = 0;
  const timedOut = await getCameraResponse(cameraAt(url, 100), range);
  assert.equal(timedOut.status, 200);
  assert.equal(timedOut.error?.type, "timeout");
  assert.equal(timedOut.body, null);

  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const disconnected = await getCameraResponse(camera, range);
  assert.equal(disconnected.error?.type, "connection");
  assert.equal(disconnected.status, null);
});

test("CLI continues after one camera fails and fetch only gets images on request", async (t) => {
  const requests: Array<{ id: string; payload: string }> = [];
  function record(id: string, fail: boolean): RequestListener {
    return (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const payload = Buffer.from(
        url.searchParams.get("s_appData") ?? "",
        "base64",
      ).toString();
      requests.push({ id, payload });
      if (fail) {
        response.writeHead(401);
        response.end();
      } else if (payload.includes("mode:range")) {
        response.end(rangeBody);
      } else {
        response.writeHead(200, { "Content-Type": contentType });
        response.end(
          /\{kind:heatmap_(mov|loi)\}/.test(payload) ? withImage : csvBody,
        );
      }
    };
  }
  const food = await mockCamera(t, record("food", true));
  const island = await mockCamera(t, record("island", false));
  const root = await temporaryDirectory(t);
  await writeEnv(root, {
    ...cameraEnv("food", food.url),
    ...cameraEnv("island", island.url),
  });
  const probe = await runCli(root, "probe");
  assert.equal(probe.code, 1);
  assert.match(probe.stdout, /success=3 no_data=0 failed=3 skipped=0/);
  assert.match(probe.stderr, /food movcnt_info:range http_error HTTP 401/);
  assert.equal(requests.length, 6);
  assert.ok(
    requests.every(({ payload }) => /kind:\w+_info},{mode:range/.test(payload)),
  );

  await writeEnv(root, cameraEnv("island", island.url));
  requests.length = 0;
  const standard = await runCli(root, "fetch");
  assert.equal(standard.code, 1);
  assert.match(standard.stderr, /food config_error.*IPRO_FOOD_BASE_URL/);
  assert.match(standard.stdout, /success=3 no_data=0 failed=0 skipped=3/);
  assert.deepEqual(
    requests.map(({ payload }) => payload),
    [
      "{{appMethod:csv},{kind:movcnt_info},{mode:latest}}",
      "{{appMethod:csv},{kind:heatmap_mov_info},{mode:latest_comp}}",
      "{{appMethod:csv},{kind:heatmap_loi_info},{mode:latest_comp}}",
    ],
  );

  requests.length = 0;
  const explicit = await runCli(
    root,
    "fetch",
    "--camera",
    "island",
    "--include-images",
  );
  assert.equal(explicit.code, 0);
  assert.equal(requests.length, 5);
  assert.ok(requests.every(({ id }) => id === "island"));
  assert.deepEqual(
    requests.slice(-2).map(({ payload }) => payload),
    [
      "{{appMethod:csv},{kind:heatmap_mov},{mode:latest_comp}}",
      "{{appMethod:csv},{kind:heatmap_loi},{mode:latest_comp}}",
    ],
  );
  assert.equal((await readdir(join(root, "runtime/goal1/island"))).length, 3);
  assert.ok(
    !(probe.stderr + probe.stdout + explicit.stdout).includes(
      credentials.password,
    ),
  );

  assert.equal((await runCli(root, "probe", "--include-images")).code, 2);
});

test("CLI reports output failures without attempting camera requests", async (t) => {
  const root = await temporaryDirectory(t);
  await writeEnv(root, cameraEnv("island", new URL("http://127.0.0.1")));
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime/goal1"), "");
  const result = await runCli(root, "fetch", "--camera", "island");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /island storage_error/);
  assert.match(result.stdout, /failed=0 skipped=3/);
});

test("history query validates explicit UTC or JST and rounds the wire range outwards", () => {
  assert.deepEqual(
    historyQuery("2027-01-01T08:45+09:00", "2027-01-01T10:15+09:00"),
    {
      window: {
        startUtc: "2026-12-31T23:45:00.000Z",
        endUtc: "2027-01-01T01:15:00.000Z",
      },
      parameters: { year: "2026", month: 12, date: 31, days: 1, hour: 2 },
    },
  );
  assert.deepEqual(
    historyQuery("2026-11-21T00:00Z", "2026-11-21T12:00Z").parameters,
    {
      year: "2026",
      month: 11,
      date: 21,
      days: 1,
      hour: 0,
    },
  );
  assert.equal(
    historyQuery("2026-11-21T00:00Z", "2026-11-27T23:00Z").parameters.days,
    6,
  );
  assert.throws(
    () => historyQuery("2026-11-21T00:00Z", "2026-11-27T23:01Z"),
    /1 and 6/,
  );
  assert.throws(
    () => historyQuery("2026-02-29T00:00Z", "2026-03-01T00:00Z"),
    /Invalid UTC/,
  );
  assert.throws(
    () => historyQuery("2026-11-21T24:00Z", "2026-11-22T01:00Z"),
    /Invalid UTC/,
  );
  assert.throws(
    () => historyQuery("2026-11-21T00:00", "2026-11-22T00:00Z"),
    /explicit/,
  );
  assert.throws(
    () => historyQuery("2026-11-21T00:00Z", "2026-11-21T00:00Z"),
    /later/,
  );
});

test("history fetch runs the same read-only CLI and retains the exact requested window", async (t) => {
  const payloads: string[] = [];
  const camera = await mockCamera(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    payloads.push(
      Buffer.from(url.searchParams.get("s_appData") ?? "", "base64").toString(),
    );
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("No Data.\r\n");
  });
  const root = await temporaryDirectory(t);
  await writeEnv(root, cameraEnv("food", camera.url));
  assert.equal(
    (await runCli(root, "fetch", "--from", "2026-11-21T00:00Z")).code,
    2,
  );
  assert.equal(
    (
      await runCli(
        root,
        "probe",
        "--from",
        "2026-11-21T00:00Z",
        "--to",
        "2026-11-22T00:00Z",
      )
    ).code,
    2,
  );
  assert.deepEqual(payloads, []);

  const args = [
    "fetch",
    "--camera",
    "food",
    "--from",
    "2026-11-21T09:00+09:00",
    "--to",
    "2026-11-21T21:00+09:00",
  ];
  const expectedPayload = (kind: string) =>
    `{{appMethod:csv},{kind:${kind}},{mode:multi},{year:2026},{month:11},{date:21},{days:1},{hour:0}}`;
  const result = await runCli(root, ...args);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /no_data=3/);
  assert.deepEqual(
    payloads,
    ["movcnt_info", "heatmap_mov_info", "heatmap_loi_info"].map(
      expectedPayload,
    ),
  );

  const runs = join(root, "runtime", "goal1", "food");
  const [run] = await readdir(runs);
  const metadata = JSON.parse(
    await readFile(join(runs, run, "movcnt_info_multi.meta.json"), "utf8"),
  );
  assert.deepEqual(metadata.window, {
    startUtc: "2026-11-21T00:00:00.000Z",
    endUtc: "2026-11-21T12:00:00.000Z",
  });
  assert.equal(metadata.result, "no_data");

  payloads.length = 0;
  assert.equal((await runCli(root, ...args, "--include-images")).code, 0);
  assert.deepEqual(
    payloads,
    [
      "movcnt_info",
      "heatmap_mov_info",
      "heatmap_loi_info",
      "heatmap_mov",
      "heatmap_loi",
    ].map(expectedPayload),
  );
});
