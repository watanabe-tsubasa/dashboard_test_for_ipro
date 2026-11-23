import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CameraId } from "../config.mts";
import type { NormalizedKind } from "../parse/csv.mts";
import type { Database } from "./database.mts";
import { prepareMeasurement, recordIdentity } from "./records.mts";
import { addCounts, emptyCounts, persistMeasurements } from "./repository.mts";

export interface Target {
  cameraId: CameraId;
  kinds: NormalizedKind[];
}

export function logIntervals(
  measurements: readonly { interval: number }[],
  log: (message: string) => void,
) {
  const others = new Set(
    measurements
      .map(({ interval }) => interval)
      .filter((interval) => interval !== 60),
  );
  if (others.size)
    log(
      `recording_interval_minutes=${[...others].join(",")} (preserved as recorded)`,
    );
}

export async function importGoal2(
  root: string,
  targets: readonly Target[],
  db: Database | undefined,
  log: (message: string) => void,
): Promise<number> {
  const total = emptyCounts();
  let files = 0;
  for (const { cameraId, kinds } of targets) {
    const cameraCounts = emptyCounts();
    let accepted = 0;
    let skipped = 0;
    let attempted = 0;
    try {
      const base = join(root, cameraId);
      const runs = await readdir(base, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const run of runs
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const directory = join(base, run.name);
        for (const file of (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .sort((a, b) => a.name.localeCompare(b.name))) {
          files++;
          try {
            const manifest: unknown = await readFile(
              join(directory, file.name),
              "utf8",
            )
              .then((json) => JSON.parse(json))
              .catch(() => {
                throw new Error("Cannot read normalized JSON.");
              });
            const {
              schemaVersion,
              cameraId: manifestCamera,
              status,
              records,
            } = (manifest ?? {}) as Record<string, unknown>;
            if (schemaVersion !== 1 || manifestCamera !== cameraId)
              throw new Error("Invalid normalized manifest.");
            if (status === "camera_error")
              throw new Error("Normalized manifest contains a camera error.");
            if (status === "range" || status === "no_data") continue;
            if (status !== "data" || !Array.isArray(records))
              throw new Error("Invalid normalized manifest.");
            const measurements = [];
            for (const record of records) {
              const identity = recordIdentity(record);
              if (identity.cameraId !== cameraId)
                throw new Error("Record does not match its manifest camera.");
              if (!kinds.includes(identity.kind)) {
                skipped++;
                continue;
              }
              measurements.push(prepareMeasurement(record));
            }
            accepted += measurements.length;
            attempted += measurements.reduce(
              (sum, record) =>
                sum + (record.kind === "linecross" ? record.lines.length : 1),
              0,
            );
            logIntervals(measurements, log);
            if (db)
              addCounts(
                cameraCounts,
                await persistMeasurements(db, measurements, log),
              );
          } catch (error) {
            cameraCounts.failures++;
            log(
              `${cameraId} import_failed — ${error instanceof Error ? error.message : "Invalid manifest."}`,
            );
          }
        }
      }
    } catch {
      cameraCounts.failures++;
      log(`${cameraId} import_failed — Could not read the Goal2 directory.`);
    }
    addCounts(total, cameraCounts);
    log(
      `${cameraId} ${db ? "import" : "dry_run"} records=${accepted} rows=${attempted} disabled=${skipped} ${writeSummary(cameraCounts)}`,
    );
  }
  if (!files) log("No Goal2 manifests were found.");
  return total.failures || !files ? 1 : 0;
}

export function writeSummary(counts: ReturnType<typeof emptyCounts>): string {
  return `inserted=${counts.inserted} updated=${counts.updated} unchanged=${counts.unchanged} corrected=${counts.corrected} unconfirmed=${counts.unconfirmed} failures=${counts.failures}`;
}
