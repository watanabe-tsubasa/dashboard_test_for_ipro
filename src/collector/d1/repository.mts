import type { CameraId } from "../config.mts";
import type { HistoryWindow } from "../history.mts";
import type { NormalizedKind } from "../parse/csv.mts";
import type { Database, Statement } from "./database.mts";
import type { Measurement } from "./records.mts";

const chunkSize = 12;

export interface WriteCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  corrected: number;
  unconfirmed: number;
  failures: number;
}

export function emptyCounts(): WriteCounts {
  return {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    corrected: 0,
    unconfirmed: 0,
    failures: 0,
  };
}

export function addCounts(total: WriteCounts, counts: WriteCounts) {
  for (const key of Object.keys(total) as (keyof WriteCounts)[]) {
    total[key] += counts[key];
  }
}

function upsertParts(record: Measurement, updatedAtUtc: string) {
  const linecross = record.kind === "linecross";
  const table = linecross ? "linecross_hourly" : "heatmaps_hourly";
  const discriminator = linecross ? "line_no" : "kind";
  const payloadColumns = linecross
    ? ["count_in", "count_out"]
    : ["grid_json", "max_value", "nonzero_cells"];
  const columns = [
    "camera_id",
    discriminator,
    "start_utc",
    "interval_minutes",
    "expected_end_utc",
    "measured_until_utc",
    "is_complete",
    ...payloadColumns,
    "source_captured_at_utc",
    "updated_at_utc",
  ];
  const values = linecross
    ? record.lines.map(({ lineNo, countIn, countOut }) => [
        lineNo,
        countIn,
        countOut,
      ])
    : [[record.kind, record.gridJson, record.max, record.nonzero]];
  const params = values.flatMap(([key, ...payload]) => [
    record.cameraId,
    key,
    record.startUtc,
    record.interval,
    record.expectedEndUtc,
    record.measuredUntilUtc,
    record.complete,
    ...payload,
    record.capturedAtUtc,
    updatedAtUtc,
  ]);

  const newerCapture = `excluded.source_captured_at_utc > COALESCE(${table}.source_captured_at_utc, '')`;
  const different = payloadColumns
    .map((column) => `excluded.${column} IS NOT ${table}.${column}`)
    .join(" OR ");
  const assignments = columns
    .slice(4)
    .map((column) => `${column}=excluded.${column}`)
    .join(", ");
  const placeholders = `(${columns.map(() => "?").join(", ")})`;
  const previous: Statement = {
    sql: `SELECT ${discriminator} AS item, is_complete FROM ${table}
          WHERE camera_id=? AND start_utc=? AND interval_minutes=?${linecross ? "" : " AND kind=?"}`,
    params: [
      record.cameraId,
      record.startUtc,
      record.interval,
      ...(linecross ? [] : [record.kind]),
    ],
  };
  const upsert: Statement = {
    sql: `INSERT INTO ${table} (${columns.join(", ")})
          VALUES ${values.map(() => placeholders).join(", ")}
          ON CONFLICT (camera_id, ${discriminator}, start_utc, interval_minutes) DO UPDATE SET ${assignments}
          WHERE excluded.is_complete > ${table}.is_complete
             OR (excluded.is_complete = ${table}.is_complete AND (
               (excluded.is_complete = 0 AND excluded.measured_until_utc > ${table}.measured_until_utc)
               OR ((excluded.is_complete = 1 OR excluded.measured_until_utc = ${table}.measured_until_utc)
                   AND (${newerCapture}) AND (${different}))
             ))
          RETURNING ${discriminator} AS item`,
    params,
  };
  return { previous, upsert, rowCount: values.length };
}

export async function persistMeasurements(
  db: Database,
  measurements: readonly Measurement[],
  log: (message: string) => void,
  updatedAtUtc = new Date().toISOString(),
) {
  const counts = emptyCounts();
  for (let offset = 0; offset < measurements.length; offset += chunkSize) {
    const records = measurements.slice(offset, offset + chunkSize);
    const operations = records.map((record) =>
      upsertParts(record, updatedAtUtc),
    );
    try {
      const results = await db.batch(
        operations.flatMap(({ previous, upsert }) => [previous, upsert]),
      );
      operations.forEach(({ rowCount }, index) => {
        const record = records[index];
        const previous = new Map(
          results[index * 2].map((row) => [row.item, row.is_complete]),
        );
        const written = results[index * 2 + 1];
        counts.unchanged += rowCount - written.length;
        for (const { item } of written) {
          if (!previous.has(item)) {
            counts.inserted++;
          } else {
            counts.updated++;
            if (previous.get(item) === 1 && record.complete === 1) {
              counts.corrected++;
              const line =
                record.kind === "linecross" && typeof item === "number"
                  ? ` line=${item}`
                  : "";
              log(
                `corrected_complete ${record.cameraId} ${record.kind}${line} ${record.startUtc} interval=${record.interval}`,
              );
            }
          }
        }
      });
    } catch (error) {
      counts.failures++;
      counts.unconfirmed += operations.reduce(
        (sum, operation) => sum + operation.rowCount,
        0,
      );
      log(
        `write_failed ${records[0].startUtc} – ${records.at(-1)?.startUtc} — ${error instanceof Error ? error.message : "DB error."}`,
      );
    }
  }
  return counts;
}

export async function completedCoverage(
  db: Database,
  camera: CameraId,
  kind: NormalizedKind,
  window: HistoryWindow,
): Promise<HistoryWindow[]> {
  const linecross = kind === "linecross";
  const [rows] = await db.batch([
    {
      sql: `SELECT start_utc, expected_end_utc
          FROM ${linecross ? "linecross_hourly" : "heatmaps_hourly"}
          WHERE camera_id = ? AND is_complete = 1 AND start_utc < ? AND expected_end_utc > ?
          ${linecross ? "GROUP BY start_utc, interval_minutes, expected_end_utc HAVING COUNT(*) = 8" : "AND kind = ?"}
          ORDER BY start_utc, expected_end_utc`,
      params: [
        camera,
        window.endUtc,
        window.startUtc,
        ...(linecross ? [] : [kind]),
      ],
    },
  ]);
  return rows.map(({ start_utc, expected_end_utc }) => {
    if (typeof start_utc !== "string" || typeof expected_end_utc !== "string") {
      throw new Error("Invalid interval returned by the database.");
    }
    return { startUtc: start_utc, endUtc: expected_end_utc };
  });
}
