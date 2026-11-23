import { type CameraId, cameraIds } from "../config.mts";
import { isWithinHistoryWindow } from "../history.mts";
import type { NormalizedKind } from "../parse/csv.mts";
import { normalizedKinds } from "../parse/response.mts";
import { requestKinds } from "./targets.mts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid normalized record or manifest object.");
  }
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  ) {
    throw new Error("Invalid normalized UTC timestamp.");
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis))
    throw new Error("Invalid normalized UTC timestamp.");
  const iso = new Date(millis).toISOString();
  if (iso.replace(/\.000Z$/, "Z") !== value.replace(/\.000Z$/, "Z")) {
    throw new Error("Invalid normalized UTC timestamp.");
  }
  return iso;
}

function integer(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`Invalid ${label} in normalized record.`);
  }
  return value;
}

export function recordIdentity(value: unknown) {
  const record = object(value);
  const cameraId = cameraIds.find((id) => id === record.cameraId);
  const kind = record.kind;
  if (
    !cameraId ||
    typeof kind !== "string" ||
    !Object.hasOwn(requestKinds, kind) ||
    record.schemaVersion !== 1
  ) {
    throw new Error(
      "Invalid camera, kind or schema version in normalized record.",
    );
  }
  return { record, cameraId, kind: kind as NormalizedKind };
}

type Values =
  | {
      kind: "linecross";
      lines: Array<{ lineNo: number; countIn: number; countOut: number }>;
    }
  | {
      kind: "heatmap_mov" | "heatmap_loi";
      gridJson: string;
      max: number;
      nonzero: number;
    };

export type Measurement = Values & {
  cameraId: CameraId;
  startUtc: string;
  expectedEndUtc: string;
  measuredUntilUtc: string;
  interval: number;
  complete: 0 | 1;
  capturedAtUtc: string;
};

export function prepareMeasurement(
  value: unknown,
  now = Date.now(),
): Measurement {
  const { record, cameraId, kind } = recordIdentity(value);
  const period = object(record.period);
  const source = object(record.source);
  const { requestKind, requestMode } = source;
  if (
    typeof requestKind !== "string" ||
    !Object.hasOwn(normalizedKinds, requestKind) ||
    normalizedKinds[requestKind as keyof typeof normalizedKinds] !== kind ||
    (requestMode !== "latest" &&
      requestMode !== "latest_comp" &&
      requestMode !== "multi")
  ) {
    throw new Error(
      "Normalized record source does not match its measurement kind.",
    );
  }

  const startUtc = timestamp(period.startUtc);
  const measuredUntilUtc = timestamp(period.endUtc);
  const capturedAtUtc = timestamp(record.acquiredAtUtc);
  const interval = integer(
    period.intervalMinutes,
    1,
    1440,
    "recording interval",
  );
  const expectedEndUtc = new Date(
    Date.parse(startUtc) + interval * 60_000,
  ).toISOString();
  const complete: 0 | 1 = measuredUntilUtc === expectedEndUtc ? 1 : 0;
  const captureTime = Date.parse(capturedAtUtc);
  const measuredTime = Date.parse(measuredUntilUtc);
  // Camera CSVs timestamp minutes; a capture near the minute boundary can be
  // timestamped just before the minute shown in the response.
  if (
    measuredUntilUtc < startUtc ||
    measuredUntilUtc > expectedEndUtc ||
    Date.parse(startUtc) > now ||
    captureTime > now ||
    measuredTime - captureTime >= 60_000 ||
    (complete === 1 && measuredTime > now)
  ) {
    throw new Error(
      "Measurement duration or acquisition timestamp is out of bounds.",
    );
  }
  if (requestMode === "multi") {
    const bounds = object(source.requestWindow);
    const window = {
      startUtc: timestamp(bounds.startUtc),
      endUtc: timestamp(bounds.endUtc),
    };
    if (
      !isWithinHistoryWindow({ startUtc, endUtc: measuredUntilUtc }, window)
    ) {
      throw new Error("Measurement falls outside its requested UTC window.");
    }
  }

  const fields = {
    cameraId,
    startUtc,
    expectedEndUtc,
    measuredUntilUtc,
    interval,
    capturedAtUtc,
    complete,
  };
  if (kind === "linecross") {
    if (!Array.isArray(record.lines) || record.lines.length !== 8) {
      throw new Error("A line-cross record must have eight distinct lines.");
    }
    const lines = record.lines.map((rawLine) => {
      const line = object(rawLine);
      return {
        lineNo: integer(line.lineNumber, 1, 8, "line number"),
        countIn: integer(line.countIn, 0, 65535, "IN count"),
        countOut: integer(line.countOut, 0, 65535, "OUT count"),
      };
    });
    if (new Set(lines.map(({ lineNo }) => lineNo)).size !== 8) {
      throw new Error("A line-cross record must have eight distinct lines.");
    }
    return { ...fields, kind, lines };
  }
  if (!Array.isArray(record.grid) || record.grid.length !== 64) {
    throw new Error("A heatmap grid must have 64 rows and 64 columns.");
  }
  let max = 0;
  let nonzero = 0;
  const grid = record.grid.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== 64) {
      throw new Error("A heatmap grid must have 64 rows and 64 columns.");
    }
    return row.map((cell) => {
      const value = integer(cell, 0, 65535, "heatmap cell");
      max = Math.max(max, value);
      nonzero += Number(value > 0);
      return value;
    });
  });
  return { ...fields, kind, gridJson: JSON.stringify(grid), max, nonzero };
}
