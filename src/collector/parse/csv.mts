import { type Period, parsePeriod } from "./period.mts";

export interface LineCount {
  lineNumber: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
  countIn: number;
  countOut: number;
  configured: boolean;
}

type Measurement =
  | { kind: "linecross"; lines: LineCount[] }
  | {
      kind: "heatmap_mov" | "heatmap_loi";
      grid: number[][];
      statistics: { nonZeroCells: number; sum: number; max: number };
    };

export type NormalizedKind = Measurement["kind"];
export type CsvMeasurement = Measurement & { period: Period };

function integer(value: string, max: number, location: string): number {
  const result = Number(value);
  if (!/^\d+$/.test(value) || result > max) {
    throw new Error(`Invalid integer in ${location}.`);
  }
  return result;
}

export function parseCsv(data: Buffer, kind: NormalizedKind): CsvMeasurement {
  const [header, ...rows] = data.toString("utf8").trimEnd().split(/\r?\n/);
  const period = parsePeriod(header.replace(/^\uFEFF/, "").split(","));

  if (kind === "linecross") {
    if (rows.length < 8) {
      throw new Error("Line-cross CSV must contain eight lines.");
    }
    const lines = rows.slice(0, 8).map((row, index) => {
      const lineNumber = index + 1;
      const columns = row.split(",");
      if (columns.length < 6 || (lineNumber < 8 && columns.length !== 6)) {
        throw new Error(`Invalid column count on line ${lineNumber}.`);
      }
      // i-PRO permits trailing fields after count_out8.
      const [startX, startY, endX, endY, countIn, countOut] = columns
        .slice(0, 6)
        .map((value, column) =>
          integer(
            value,
            column < 4 ? 799 : 65535,
            `line ${lineNumber}, column ${column + 1}`,
          ),
        );
      return {
        lineNumber,
        start: { x: startX, y: startY },
        end: { x: endX, y: endY },
        countIn,
        countOut,
        configured: startX !== 0 || startY !== 0 || endX !== 0 || endY !== 0,
      };
    });
    return { kind, period, lines };
  }

  if (rows.length !== 64) {
    throw new Error("Heatmap CSV must contain 64 grid rows.");
  }
  const statistics = { nonZeroCells: 0, sum: 0, max: 0 };
  const grid = rows.map((row, y) => {
    const cells = row.split(",");
    if (cells.length !== 64) {
      throw new Error(`Heatmap row ${y + 1} must contain 64 cells.`);
    }
    return cells.map((cell, x) => {
      const count = integer(
        cell,
        65535,
        `heatmap row ${y + 1}, column ${x + 1}`,
      );
      statistics.nonZeroCells += Number(count > 0);
      statistics.sum += count;
      statistics.max = Math.max(statistics.max, count);
      return count;
    });
  });
  return { kind, period, grid, statistics };
}
