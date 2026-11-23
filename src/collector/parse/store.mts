import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CgiRequest } from "../cgi.mts";
import { type CameraId, cameraIds } from "../config.mts";
import {
  type HistoryWindow,
  historyQuery,
  isWithinHistoryWindow,
} from "../history.mts";
import { maxResponseBytes } from "../iproClient.mts";
import type { CsvMeasurement } from "./csv.mts";
import {
  normalizedKinds,
  type PartMetadata,
  parseResponse,
} from "./response.mts";

type RequestKind = keyof typeof normalizedKinds;
type RequestMode = CgiRequest["mode"];

interface CapturePath {
  cameraId: CameraId;
  runId: string;
  rawFile: string;
  stem: string;
}

interface CaptureMetadata {
  kind: RequestKind;
  mode: RequestMode;
  acquiredAtUtc: string;
  contentType: string | null;
  boundary: string | null;
  byteLength: number;
  window?: HistoryWindow;
}

export interface RecordSource extends PartMetadata {
  runId: string;
  requestKind: RequestKind;
  requestMode: RequestMode;
  rawFile: string;
  requestWindow?: HistoryWindow;
}

export type NormalizedRecord = CsvMeasurement & {
  schemaVersion: 1;
  cameraId: CameraId;
  acquiredAtUtc: string;
  source: RecordSource;
};

export function capturePath(root: string, file: string): CapturePath {
  const underRoot = relative(root, resolve(file));
  const [camera, runId, filename, extra] = underRoot.split(sep);
  const cameraId = cameraIds.find((id) => id === camera);
  if (
    isAbsolute(underRoot) ||
    !cameraId ||
    !/^[a-z0-9][a-z0-9_-]*$/i.test(runId ?? "") ||
    !/^[a-z0-9_]+\.bin$/i.test(filename ?? "") ||
    extra !== undefined
  ) {
    throw new Error(
      "Expected a .bin under the capture root at <camera>/<run-id>/.",
    );
  }
  return {
    cameraId,
    runId,
    rawFile: resolve(file),
    stem: filename.slice(0, -4),
  };
}

export async function discoverCaptures(
  root: string,
  cameras: readonly CameraId[],
) {
  const paths: CapturePath[] = [];
  for (const camera of cameras) {
    const directory = join(root, camera);
    const runs = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw new Error(`Cannot read the capture directory for ${camera}.`);
      },
    );
    for (const run of runs
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const runPath = join(directory, run.name);
      const files = await readdir(runPath, { withFileTypes: true });
      const stems = new Set(
        files
          .filter(
            (entry) =>
              entry.isFile() && /\.(?:bin|meta\.json)$/.test(entry.name),
          )
          .map((entry) => entry.name.replace(/\.(?:bin|meta\.json)$/, "")),
      );
      for (const stem of [...stems].sort()) {
        paths.push(capturePath(root, join(runPath, `${stem}.bin`)));
      }
    }
  }
  return paths;
}

async function readMetadata(capture: CapturePath): Promise<CaptureMetadata> {
  let data: unknown;
  try {
    data = JSON.parse(
      await readFile(`${capture.rawFile.slice(0, -4)}.meta.json`, "utf8"),
    );
  } catch {
    throw new Error("Capture metadata is missing, unreadable or invalid JSON.");
  }
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid capture metadata.");
  }
  const {
    cameraId,
    kind,
    mode,
    fetchedAt,
    contentType,
    boundary,
    byteLength,
    httpStatus,
    window,
  } = data as Record<string, unknown>;
  if (
    cameraId !== capture.cameraId ||
    typeof kind !== "string" ||
    !Object.hasOwn(normalizedKinds, kind) ||
    (mode !== "range" &&
      mode !== "latest" &&
      mode !== "latest_comp" &&
      mode !== "multi") ||
    capture.stem !== `${kind}_${mode}` ||
    typeof fetchedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(fetchedAt) ||
    !Number.isFinite(Date.parse(fetchedAt)) ||
    !(contentType === null || typeof contentType === "string") ||
    !(boundary === null || typeof boundary === "string")
  ) {
    throw new Error("Invalid capture metadata or source path mismatch.");
  }
  const acquiredAtUtc = new Date(fetchedAt).toISOString();
  if (
    acquiredAtUtc.replace(/\.000Z$/, "Z") !== fetchedAt.replace(/\.000Z$/, "Z")
  ) {
    throw new Error("Invalid capture acquisition timestamp.");
  }
  if (httpStatus !== 200) {
    const status =
      typeof httpStatus === "number" && httpStatus >= 100 && httpStatus <= 599
        ? httpStatus
        : "unavailable";
    throw new Error(`Capture did not complete with HTTP 200 (HTTP ${status}).`);
  }
  if (
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > maxResponseBytes
  ) {
    throw new Error(
      "Capture has no complete body or its byte length is invalid.",
    );
  }
  let requestWindow: HistoryWindow | undefined;
  if (mode === "multi") {
    const fields = window as Partial<HistoryWindow> | null | undefined;
    if (
      typeof fields?.startUtc !== "string" ||
      typeof fields.endUtc !== "string"
    ) {
      throw new Error("History capture is missing its requested UTC window.");
    }
    requestWindow = historyQuery(fields.startUtc, fields.endUtc).window;
  }
  return {
    kind: kind as RequestKind,
    mode,
    acquiredAtUtc,
    contentType,
    boundary,
    byteLength,
    window: requestWindow,
  };
}

async function writeAtomically(path: string, data: string | Buffer) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error("Could not write normalized output.");
  }
}

export async function readCapture(capture: CapturePath) {
  const metadata = await readMetadata(capture);
  const info = await stat(capture.rawFile).catch(() => null);
  if (!info?.isFile()) {
    throw new Error("Capture body is missing or unreadable.");
  }
  if (info.size !== metadata.byteLength) {
    throw new Error("Capture body size differs from its metadata.");
  }
  let body: Buffer;
  try {
    body = await readFile(capture.rawFile);
  } catch {
    throw new Error("Capture body is missing or unreadable.");
  }
  if (body.length !== metadata.byteLength) {
    throw new Error("Capture body size differs from its metadata.");
  }
  return { metadata, body };
}

export async function normalizeCapture(
  capture: CapturePath,
  outputRoot: string,
) {
  const { metadata, body } = await readCapture(capture);
  const parsed = parseResponse(body, metadata);
  const source = {
    runId: capture.runId,
    requestKind: metadata.kind,
    requestMode: metadata.mode,
    rawFile: relative(process.cwd(), capture.rawFile),
    ...(metadata.window ? { requestWindow: metadata.window } : {}),
  };
  const base = {
    schemaVersion: 1 as const,
    cameraId: capture.cameraId,
    acquiredAtUtc: metadata.acquiredAtUtc,
    source,
  };

  const directory = join(outputRoot, capture.cameraId, capture.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => {
    throw new Error("Could not create the normalized output directory.");
  });
  const outputPath = join(directory, `${capture.stem}.json`);
  if (parsed.status !== "data") {
    const result = { ...base, ...parsed };
    await writeAtomically(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    return { ...result, outputPath };
  }

  const window = metadata.window;
  const included = window
    ? parsed.records.filter(({ period }) =>
        isWithinHistoryWindow(period, window),
      )
    : parsed.records;
  const selectedPartNumbers = new Set(
    included.map(({ part }) => part.partNumber),
  );
  const filteredRecords = parsed.records.length - included.length;
  if (!included.length) {
    const result = {
      ...base,
      status: "no_data" as const,
      reason: "outside_window" as const,
      filteredRecords,
    };
    await writeAtomically(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    return { ...result, outputPath };
  }

  const records: NormalizedRecord[] = included.map(({ part, ...record }) => ({
    ...record,
    ...base,
    source: { ...source, ...part },
  }));
  const images = [];
  for (const { data, ...image } of parsed.images) {
    if (
      image.csvPartNumber !== null &&
      !selectedPartNumbers.has(image.csvPartNumber)
    ) {
      continue;
    }
    const digest = createHash("sha256").update(data).digest("hex");
    const localPath = `${capture.stem}_part-${image.partNumber}_${digest}.jpg`;
    await writeAtomically(join(directory, localPath), data);
    images.push({ ...image, localPath });
  }
  const result = {
    ...base,
    status: parsed.status,
    records,
    images,
    ...(window ? { filteredRecords } : {}),
  };
  await writeAtomically(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return { ...result, outputPath };
}
