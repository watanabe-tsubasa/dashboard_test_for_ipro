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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { utcToJst } from "../time.mts";
import { parseCsv } from "./csv.mts";
import { multipartBoundary, parseMultipart } from "./multipart.mts";
import { parseResponse } from "./response.mts";

const boundary = "fixture-boundary";
const contentType = `multipart/form-data; Boundary = "${boundary}"`;
const latest = {
  kind: "heatmap_mov_info",
  mode: "latest_comp",
  contentType,
  boundary: null,
} as const;
const periodHeader = "20261231,2345,20270101,0000,00:15,+09:00,OUT";

function heatmap(header = periodHeader, nonzero = false) {
  const rows = Array.from({ length: 64 }, () => Array<number>(64).fill(0));
  if (nonzero) {
    rows[1][31] = 7;
    rows[12][4] = 19;
  }
  return Buffer.from(
    `${header}\r\n${rows.map((row) => row.join(",")).join("\r\n")}\r\n`,
  );
}

function linecross(header = periodHeader) {
  const rows = [
    "10,0,20,2,5,3",
    ...Array<string>(6).fill("0,0,0,0,0,0"),
    "0,0,0,0,9,1,extra",
  ];
  return Buffer.from([header, ...rows, "extra,row", ""].join("\r\n"));
}

interface FixturePart {
  filename: string;
  data: Buffer;
  type?: string;
  length?: number | false;
  sharedLineEnding?: boolean;
}

function multipart(parts: FixturePart[], newline = "\r\n") {
  const buffers = parts.flatMap(
    ({
      filename,
      data,
      type = "text/plain",
      length = data.length,
      sharedLineEnding,
    }) => [
      Buffer.from(
        [
          `--${boundary}`,
          `cOnTent-DiSpOsItIoN: form-data; name="data"; filename="${filename}"`,
          `Content-Type:${type}`,
          ...(length === false ? [] : [`CONTENT-LENGTH: ${length}`]),
          "",
          "",
        ].join(newline),
      ),
      data,
      Buffer.from(sharedLineEnding ? "" : newline),
    ],
  );
  return Buffer.concat([...buffers, Buffer.from(`--${boundary}--${newline}`)]);
}

const jpeg = Buffer.from([0xff, 0xd8, 0, 0x80, 0x0d, 0x0a, 0x7f, 0xff, 0xd9]);

test("parses exact grid orientation, zero statistics and CSV-only multipart variations", () => {
  assert.equal(
    multipartBoundary(` Multipart/Mixed; charset=utf-8; BOUNDARY=${boundary}`),
    boundary,
  );
  const result = parseResponse(
    multipart(
      [
        {
          filename: "heatmap_latest_comp.csv",
          data: heatmap(undefined, true),
          length: false,
        },
      ],
      "\n",
    ),
    latest,
  );
  assert.equal(result.status, "data");
  assert.equal(result.images.length, 0);
  const [record] = result.records;
  assert.equal(record.kind, "heatmap_mov");
  assert.equal(record.grid.length, 64);
  assert.equal(record.grid[1].length, 64);
  assert.equal(record.grid[1][31], 7);
  assert.equal(record.grid[31][1], 0);
  assert.deepEqual(record.statistics, { nonZeroCells: 2, sum: 26, max: 19 });
  const zero = parseCsv(heatmap(), "heatmap_loi");
  assert.equal(zero.kind, "heatmap_loi");
  assert.deepEqual(zero.statistics, { nonZeroCells: 0, sum: 0, max: 0 });
});

test("extracts multiple CSV and JPEG parts and links only uniquely matching names", () => {
  const csv = heatmap();
  const embeddedBoundary = Buffer.concat([
    jpeg.subarray(0, -2),
    Buffer.from(`\r\n--${boundary}\r\n`),
    jpeg.subarray(-2),
  ]);
  const result = parseResponse(
    multipart([
      {
        filename: "heatmap_202612312345_202701010000.csv",
        data: csv,
        sharedLineEnding: true,
      },
      {
        filename: "index_202612312345_202701010000.jpg",
        type: "image/jpeg",
        data: embeddedBoundary,
      },
      {
        filename: "heatmap_202701010000_202701010015.csv",
        data: heatmap("20270101,0000,20270101,0015,00:15,+09:00,OUT"),
      },
      {
        filename: "unmatched.jpg",
        type: "IMAGE/JPEG",
        data: jpeg,
        length: false,
      },
    ]),
    latest,
  );
  assert.equal(result.status, "data");
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].part.byteLength, csv.length);
  assert.equal(result.images.length, 2);
  assert.deepEqual(result.images[0].data, embeddedBoundary);
  assert.deepEqual(result.images[0].period, result.records[0].period);
  assert.equal(result.images[0].csvPartNumber, 1);
  assert.deepEqual(result.images[1].data, jpeg);
  assert.equal(result.images[1].period, null);
});

test("preserves all eight line counts, ignores only trailing fields and parses intervals across boundaries", () => {
  const result = parseCsv(linecross(), "linecross");
  assert.equal(result.kind, "linecross");
  assert.equal(result.period.intervalMinutes, 15);
  assert.equal(result.period.startUtc, "2026-12-31T23:45:00.000Z");
  assert.equal(result.period.endUtc, "2027-01-01T00:00:00.000Z");
  assert.equal(
    utcToJst(result.period.startUtc),
    "2027-01-01T08:45:00.000+09:00",
  );
  assert.equal(result.period.cameraTimezone, "+09:00");
  assert.equal(result.period.summertime, "OUT");
  assert.deepEqual(
    result.lines.map((line) => line.lineNumber),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.deepEqual(result.lines[0], {
    lineNumber: 1,
    start: { x: 10, y: 0 },
    end: { x: 20, y: 2 },
    countIn: 5,
    countOut: 3,
    configured: true,
  });
  assert.equal(result.lines[7].configured, false);
  assert.equal(result.lines[7].countIn, 9);

  for (const [interval, expected] of [
    ["01:00", 60],
    ["12:00", 720],
    ["24:00", 1440],
  ] as const) {
    const csv = linecross(`20260228,2359,20260301,0001,${interval},-02:30,IN`);
    const { period } = parseCsv(csv, "linecross");
    assert.equal(period.intervalMinutes, expected);
    assert.equal(period.endUtc, "2026-03-01T00:01:00.000Z");
    assert.equal(period.cameraTimezone, "-02:30");
    assert.equal(period.summertime, "IN");
  }
});

test("keeps No Data variants and range responses distinct", () => {
  for (const [text, code, status] of [
    ["No Data.", 0, "no_data"],
    ["No Data(1).", 1, "no_data"],
    ["No Data(2).", 2, "no_data"],
    ["No Data(3).", 3, "camera_error"],
  ]) {
    assert.deepEqual(parseResponse(Buffer.from(`${text}\r\n`), latest), {
      status,
      code,
    });
  }
  const context = { ...latest, mode: "range", contentType: "text/plain" };
  assert.deepEqual(
    parseResponse(
      Buffer.from("DataFrom=2026112100(UTC)\r\nDataUntil=2026112213(UTC)\r\n"),
      context,
    ),
    {
      status: "range",
      dataFromUtc: "2026-11-21T00:00:00.000Z",
      dataUntilUtc: "2026-11-22T13:00:00.000Z",
      precision: "hour",
    },
  );
  const minutes = parseResponse(
    Buffer.from("DataFrom=202611210015(UTC)\nDataUntil=202611221345(UTC)\n"),
    context,
  );
  assert.equal(minutes.status, "range");
  assert.equal(minutes.precision, "minute");
  assert.equal(minutes.dataUntilUtc, "2026-11-22T13:45:00.000Z");
  assert.throws(() => parseResponse(heatmap(), context), /Invalid range/);
});

test("rejects bad fields, invalid sizes, unknown parts and dangerous filenames", () => {
  const data = heatmap();
  assert.throws(
    () =>
      parseCsv(
        heatmap(periodHeader.replace("20261231", "20260230")),
        "heatmap_mov",
      ),
    /Invalid UTC/,
  );
  assert.throws(
    () =>
      parseCsv(heatmap(periodHeader.replace("00:15", "24:15")), "heatmap_mov"),
    /interval/,
  );
  assert.throws(
    () =>
      parseCsv(
        Buffer.from(data.toString().replace(/0,0,0,/, "NaN,0,0,")),
        "heatmap_mov",
      ),
    /Invalid integer/,
  );
  assert.throws(
    () =>
      parseCsv(
        Buffer.from(data.toString().replace(/0,0,0,/, "0,0,")),
        "heatmap_mov",
      ),
    /64 cells/,
  );
  assert.throws(
    () =>
      parseCsv(
        Buffer.from(data.toString().split("\r\n").slice(0, 64).join("\r\n")),
        "heatmap_mov",
      ),
    /64 grid rows/,
  );
  assert.throws(
    () =>
      parseCsv(
        Buffer.from(
          linecross().toString().replace("10,0,20,2,5,3", "10,0,20,2,5"),
        ),
        "linecross",
      ),
    /column count/,
  );

  for (const filename of ["../leak.jpg", "..\\leak.jpg", "/leak.jpg"]) {
    assert.throws(
      () =>
        parseMultipart(
          multipart([{ filename, data: jpeg, type: "image/jpeg" }]),
          boundary,
        ),
      /Unsafe/,
    );
  }
  assert.throws(
    () =>
      parseMultipart(
        multipart([
          { filename: "blob.bin", data, type: "application/octet-stream" },
        ]),
        boundary,
      ),
    /Unsupported/,
  );
  assert.throws(
    () =>
      parseMultipart(
        multipart([{ filename: "heatmap.csv", data, length: data.length + 4 }]),
        boundary,
      ),
    /Content-Length/,
  );
  assert.throws(
    () =>
      parseMultipart(
        multipart([
          {
            filename: "index.jpg",
            data: jpeg.subarray(0, -2),
            type: "image/jpeg",
          },
        ]),
        boundary,
      ),
    /incomplete JPEG/,
  );
  const truncated = multipart([
    { filename: "heatmap.csv", data, length: false },
  ]).subarray(0, -25);
  assert.throws(() => parseMultipart(truncated, boundary), /closing boundary/);
});

test("offline CLI preserves originals, extracts JPEG exactly, repeats deterministically and reports missing metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ipro-parse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relativeDir = "runtime/goal1/island/run-01";
  const output = join(root, "runtime/goal2/island/run-01");
  await mkdir(join(root, relativeDir), { recursive: true });
  const rawFile = `${relativeDir}/heatmap_mov_latest_comp.bin`;
  const metadata = {
    cameraId: "island",
    fetchedAt: "2027-01-01T00:05:00.000Z",
    httpStatus: 200,
    contentType,
    kind: "heatmap_mov",
    mode: "latest_comp",
    boundary: null,
  };
  const body = multipart([
    { filename: "heatmap_mov_info_latest_comp.csv", data: heatmap() },
    { filename: "index_latest_comp.jpg", type: "image/jpeg", data: jpeg },
  ]);
  const metaFile = join(root, relativeDir, "heatmap_mov_latest_comp.meta.json");
  const originalMetadata = JSON.stringify({
    ...metadata,
    byteLength: body.length,
  });
  await writeFile(join(root, rawFile), body);
  await writeFile(metaFile, originalMetadata);

  const script = fileURLToPath(new URL("./cli.mts", import.meta.url));
  const run = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", script, ...args],
      { cwd: root },
    );
  const single = await run("--file", rawFile);
  assert.match(single.stdout, /success records=1 jpeg=1/);
  const manifest = join(output, "heatmap_mov_latest_comp.json");
  const first = await readFile(manifest, "utf8");
  const parsed = JSON.parse(first);
  assert.equal(parsed.records[0].source.rawFile, rawFile);
  assert.equal(parsed.records[0].acquiredAtUtc, metadata.fetchedAt);
  assert.equal(parsed.records[0].period.startUtc, "2026-12-31T23:45:00.000Z");
  assert.equal(parsed.images[0].partFilename, "index_latest_comp.jpg");
  assert.deepEqual(
    await readFile(join(output, parsed.images[0].localPath)),
    jpeg,
  );

  assert.match(
    (await run("--camera", "island")).stdout,
    /island summary success=1/,
  );
  assert.equal(await readFile(manifest, "utf8"), first);
  assert.equal((await readdir(output)).length, 2);
  assert.deepEqual(await readFile(join(root, rawFile)), body);
  assert.equal(await readFile(metaFile, "utf8"), originalMetadata);

  await writeFile(
    join(root, relativeDir, "movcnt_info_latest.bin"),
    linecross(),
  );
  await assert.rejects(run(), { code: 1, stderr: /metadata is missing/ });
});

test("multi normalization uses complete CSV intervals and keeps the matching image only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ipro-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = join(root, "goal1");
  const directory = join(inputRoot, "island", "run-01");
  await mkdir(directory, { recursive: true });
  const parts = [
    // A misleading filename must not override the period in the CSV.
    {
      filename: "heatmap_202611210015_202611210030.csv",
      data: heatmap("20261121,0000,20261121,0015,00:15,+09:00,OUT"),
    },
    {
      filename: "index_202611210015_202611210030.jpg",
      type: "image/jpeg",
      data: jpeg,
    },
    {
      filename: "heatmap_202611210015_202611210045.csv",
      data: heatmap("20261121,0015,20261121,0045,00:15,+09:00,OUT"),
    },
    {
      filename: "heatmap_202611210030_202611210045.csv",
      data: heatmap("20261121,0015,20261121,0030,00:15,+09:00,OUT", true),
    },
    {
      filename: "index_202611210030_202611210045.jpg",
      type: "image/jpeg",
      data: jpeg,
    },
    {
      filename: "heatmap_202611210045_202611210100.csv",
      data: heatmap("20261121,0030,20261121,0045,00:15,+09:00,OUT"),
    },
  ];
  const body = multipart(parts);
  const base = join(directory, "heatmap_mov_multi");
  await writeFile(`${base}.bin`, body);
  const window = {
    startUtc: "2026-11-21T00:15:00.000Z",
    endUtc: "2026-11-21T00:30:00.000Z",
  };
  const meta = {
    cameraId: "island",
    fetchedAt: "2026-11-22T00:00:00.000Z",
    kind: "heatmap_mov",
    mode: "multi",
    httpStatus: 200,
    contentType,
    boundary,
    byteLength: body.length,
    window,
  };
  await writeFile(`${base}.meta.json`, JSON.stringify(meta));
  const { capturePath, normalizeCapture } = await import("./store.mts");
  const capture = capturePath(inputRoot, `${base}.bin`);
  const output = join(root, "goal2");
  const result = await normalizeCapture(capture, output);
  assert.equal(result.status, "data");
  assert.equal(result.filteredRecords, 3);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].source.requestMode, "multi");
  assert.deepEqual(result.records[0].source.requestWindow, window);
  assert.equal(result.records[0].period.startUtc, window.startUtc);
  assert.equal(result.records[0].period.endUtc, window.endUtc);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].partNumber, 5);

  await writeFile(
    `${base}.meta.json`,
    JSON.stringify({
      ...meta,
      window: {
        startUtc: "2026-11-21T04:00:00.000Z",
        endUtc: "2026-11-21T05:00:00.000Z",
      },
    }),
  );
  const empty = await normalizeCapture(capture, output);
  assert.equal(empty.status, "no_data");
  assert.ok("reason" in empty);
  assert.equal(empty.reason, "outside_window");
  assert.equal(empty.filteredRecords, 4);

  await writeFile(
    `${base}.meta.json`,
    JSON.stringify({ ...meta, window: null }),
  );
  await assert.rejects(
    normalizeCapture(capture, output),
    /missing its requested UTC window/,
  );
});
