import { join } from "node:path";
import type { CgiRequest } from "../cgi.mts";
import {
  type CameraConfig,
  type CameraId,
  readCameraConfig,
} from "../config.mts";
import { type HistoryWindow, isWithinHistoryWindow } from "../history.mts";
import { getCameraResponse } from "../iproClient.mts";
import type { NormalizedKind } from "../parse/csv.mts";
import { parseResponse } from "../parse/response.mts";
import { capturePath, normalizeCapture } from "../parse/store.mts";
import { createRunDirectory, newRunId, saveResponse } from "../rawStore.mts";
import type { Database } from "./database.mts";
import { logIntervals, type Target, writeSummary } from "./import.mts";
import {
  type Bounds,
  dailyWindows,
  retainedWindow,
  windowForRequest,
} from "./planner.mts";
import { prepareMeasurement } from "./records.mts";
import {
  addCounts,
  completedCoverage,
  emptyCounts,
  persistMeasurements,
  type WriteCounts,
} from "./repository.mts";
import { requestKinds } from "./targets.mts";

class CaptureError extends Error {
  readonly oversized: boolean;

  constructor(message: string, oversized = false) {
    super(message);
    this.oversized = oversized;
  }
}

async function capture(
  camera: CameraConfig,
  request: CgiRequest,
  runtime: string,
  dryRun = false,
) {
  const response = await getCameraResponse(camera, request);
  const failed =
    response.status !== 200 || response.error || response.body === null;
  if (dryRun) {
    if (request.mode !== "range")
      throw new Error("Dry run only requests the retention range.");
    if (response.status === 200 && !response.error && response.body !== null) {
      const parsed = parseResponse(response.body, {
        kind: request.kind,
        mode: "range",
        contentType: response.contentType,
        boundary: null,
      });
      if (
        parsed.status === "range" ||
        parsed.status === "no_data" ||
        parsed.status === "camera_error"
      )
        return parsed;
    }
  } else {
    const rawRoot = join(runtime, "goal1");
    const directory = await createRunDirectory(
      rawRoot,
      camera.id,
      newRunId(),
    ).catch(() => {
      throw new Error("Could not create a raw capture directory.");
    });
    const saved = await saveResponse(
      directory,
      camera,
      request,
      response,
      new Date().toISOString(),
    ).catch(() => {
      throw new Error("Could not save the raw response.");
    });
    if (!failed && saved.bodyPath) {
      return await normalizeCapture(
        capturePath(rawRoot, saved.bodyPath),
        join(runtime, "goal2"),
      );
    }
  }
  const status = response.status === null ? "" : ` HTTP ${response.status}`;
  const reason = response.error ? ` ${response.error.type}` : "";
  throw new CaptureError(
    `Camera request failed.${status}${reason}`,
    response.error?.type === "response_too_large",
  );
}

interface CollectionOptions {
  action: "backfill" | "sync";
  bounds: Bounds;
  runtime: string;
  dryRun: boolean;
  db?: Database;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
  onEvent?: (event: CollectionEvent) => void;
}

export type CollectionEvent = { camera: CameraId; kind: NormalizedKind } & (
  | { type: "target" }
  | {
      type: "plan";
      startUtc: string;
      endUtc: string;
      multi: number;
      latest: boolean;
    }
  | { type: "progress"; completed: number; total: number }
  | { type: "result"; counts: WriteCounts; noData: number; records: number }
);

export async function collectHistory(
  targets: readonly Target[],
  options: CollectionOptions,
): Promise<number> {
  const { action, bounds, runtime, dryRun, db, env, log, onEvent } = options;
  let failed = false;
  for (const { cameraId, kinds } of targets) {
    if (!kinds.length) {
      log(`${cameraId} skipped (no enabled kinds)`);
      continue;
    }
    const { camera, error } = readCameraConfig(cameraId, env);
    if (!camera) {
      log(`${cameraId} config_error — ${error}`);
      failed = true;
      continue;
    }
    for (const kind of kinds) {
      const target = { camera: cameraId, kind };
      onEvent?.({ ...target, type: "target" });
      const cgi = requestKinds[kind];
      const label = `${cameraId} ${kind}`;
      const totals = emptyCounts();
      let skipped = 0;
      let sources = 0;
      let accepted = 0;
      let filtered = 0;

      try {
        const range = await capture(
          camera,
          { kind: cgi, mode: "range" },
          runtime,
          dryRun,
        );
        if (range.status === "no_data") {
          log(
            `${label} skipped (range no_data ${"code" in range ? range.code : range.reason})`,
          );
          onEvent?.({
            ...target,
            type: "result",
            counts: totals,
            noData: 1,
            records: 0,
          });
          continue;
        }
        if (range.status !== "range")
          throw new Error("Camera returned an invalid retention range.");
        log(`${label} range ${range.dataFromUtc} – ${range.dataUntilUtc}`);
        const window = retainedWindow(range, bounds, Date.now());
        if (!window) {
          log(`${label} skipped (requested range outside retention)`);
          onEvent?.({
            ...target,
            type: "result",
            counts: totals,
            noData: 0,
            records: 0,
          });
          continue;
        }

        const retained = window;
        const coverage =
          action === "sync" && db
            ? await completedCoverage(db, cameraId, kind, window)
            : undefined;
        const windows = dailyWindows(window, coverage);
        const getLatest =
          action === "sync" &&
          bounds.from === undefined &&
          bounds.to === undefined;
        log(
          `${label} ${dryRun ? "dry_run" : action} ${window.startUtc} – ${window.endUtc} multi=${windows.length} latest=${Number(getLatest)}`,
        );
        onEvent?.({
          ...target,
          type: "plan",
          ...window,
          multi: windows.length,
          latest: getLatest,
        });
        if (dryRun) {
          onEvent?.({
            ...target,
            type: "result",
            counts: totals,
            noData: 0,
            records: 0,
          });
          continue;
        }
        if (!db) throw new Error("Database is required for collection.");
        const total = windows.length + Number(getLatest);
        let completed = 0;

        async function consume(
          connection: Database,
          config: CameraConfig,
          request: CgiRequest,
          portion?: HistoryWindow,
        ) {
          const result = await capture(config, request, runtime);
          if (result.status === "no_data") {
            skipped++;
            if ("filteredRecords" in result) filtered += result.filteredRecords;
            log(
              `${label} ${request.mode} ${portion?.startUtc ?? ""} no_data (${"code" in result ? result.code : result.reason})`,
            );
            return;
          }
          if (result.status !== "data")
            throw new Error("Camera returned an invalid measurement response.");
          sources++;
          const selected = portion
            ? result.records.filter(
                ({ period }) =>
                  period.startUtc < portion.endUtc &&
                  isWithinHistoryWindow(period, retained),
              )
            : result.records;
          accepted += selected.length;
          filtered +=
            (result.filteredRecords ?? 0) +
            result.records.length -
            selected.length;
          const measurements = selected.map((record) =>
            prepareMeasurement(record),
          );
          logIntervals(measurements, log);
          const counts = await persistMeasurements(
            connection,
            measurements,
            log,
          );
          addCounts(totals, counts);
          log(
            `${label} ${request.mode} ${portion?.startUtc ?? ""} records=${selected.length}/${result.records.length + (result.filteredRecords ?? 0)} ${writeSummary(counts)}`,
          );
        }

        for (const portion of windows) {
          const request = {
            kind: cgi,
            mode: "multi",
            window: windowForRequest(portion, window),
          } as const;
          try {
            try {
              await consume(db, camera, request, portion);
            } catch (error) {
              if (
                !(error instanceof CaptureError && error.oversized) ||
                request.window.endUtc === portion.endUtc
              )
                throw error;
              log(
                `${label} ${portion.startUtc} response too large with boundary overlap; retrying the UTC day.`,
              );
              await consume(
                db,
                camera,
                { ...request, window: portion },
                portion,
              );
            }
          } catch (error) {
            totals.failures++;
            log(
              `${label} multi ${portion.startUtc} failed — ${error instanceof Error ? error.message : "Collection error."}`,
            );
          } finally {
            onEvent?.({
              ...target,
              type: "progress",
              completed: ++completed,
              total,
            });
          }
        }
        if (getLatest) {
          const request =
            cgi === "movcnt_info"
              ? ({ kind: cgi, mode: "latest" } as const)
              : ({ kind: cgi, mode: "latest_comp" } as const);
          try {
            await consume(db, camera, request);
          } catch (error) {
            totals.failures++;
            log(
              `${label} latest failed — ${error instanceof Error ? error.message : "Collection error."}`,
            );
          } finally {
            onEvent?.({
              ...target,
              type: "progress",
              completed: ++completed,
              total,
            });
          }
        }
      } catch (error) {
        totals.failures++;
        log(
          `${label} failed — ${error instanceof Error ? error.message : "Collection error."}`,
        );
      }
      if (!dryRun || totals.failures) {
        log(
          `${label} summary responses=${sources} no_data=${skipped} records=${accepted} filtered=${filtered} ${writeSummary(totals)}`,
        );
      }
      onEvent?.({
        ...target,
        type: "result",
        counts: totals,
        noData: skipped,
        records: accepted,
      });
      failed ||= totals.failures > 0;
    }
  }
  return failed ? 1 : 0;
}
