import { resolve } from "node:path";
import { cameraIds } from "../config.mts";
import { type CollectionEvent, collectHistory } from "../d1/collect.mts";
import { d1Database, readD1Config } from "../d1/database.mts";
import { addCounts, emptyCounts } from "../d1/repository.mts";
import { readTargets } from "../d1/targets.mts";
import { readR2Config } from "../r2/config.mts";
import { createR2Store } from "../r2/storage.mts";
import { refreshCameraThumbnail } from "../r2/thumbnail.mts";
import type { JobProgress, JobReport } from "./contract.mts";
import { backfillBounds } from "./input.mts";
import type { openJobs } from "./jobs.mts";
import { createRedactor } from "./redact.mts";

export async function runJob(
  id: string,
  jobs: ReturnType<typeof openJobs>,
  env: NodeJS.ProcessEnv,
  runtime = resolve("runtime"),
) {
  const job = jobs.claim(id);
  if (!job) return 1;
  const safe = createRedactor(env);
  const log = (message: string) => jobs.append(id, safe(message));
  const progress: JobProgress = { completedTargets: 0, totalTargets: 0 };
  const report: JobReport = {
    plans: [],
    targets: [],
    counts: { ...emptyCounts(), noData: 0, records: 0 },
  };
  const update = () => jobs.update(id, progress, report);
  let exit = 1;
  let error: string | null =
    "処理中にエラーが発生しました。実行ログを確認してください。";
  try {
    log("ジョブの実行を開始しました。");
    const request = job.request;
    if (request.operation === "thumbnail") {
      const config = readR2Config(env);
      if (!config) throw new Error("R2の設定がありません。");
      const store = createR2Store(config);
      try {
        Object.assign(progress, { camera: request.camera, totalTargets: 1 });
        update();
        const result = await refreshCameraThumbnail(request.camera, {
          env,
          runtime,
          store,
        });
        if (result.status === "dry_run")
          throw new Error("予期しない画像更新結果です。");
        const rejected =
          result.status === "failed" || result.status === "uncertain";
        report.thumbnail = {
          outcome: result.status,
          lastModifiedUtc: result.lastModifiedUtc,
          retrievedAtUtc:
            result.image?.retrievedAtUtc ??
            (result.status === "no_data" ? result.retrievedAtUtc : undefined),
          bytes: result.image?.bytes,
          ...(rejected ? { errorCode: result.error.code } : {}),
        };
        if (rejected) {
          error =
            result.status === "uncertain"
              ? "R2の更新結果を確認できませんでした。"
              : "画像を更新できませんでした。";
          log(`${result.error.code} — ${result.error.message}`);
        } else {
          exit = 0;
          error = null;
          log(
            result.status === "uploaded"
              ? "画像を保存し、HEADとGETで照合しました。"
              : result.status === "unchanged"
                ? "同じ画像が保存されています。"
                : "カメラはデータなしと応答しました。",
          );
        }
        progress.completedTargets = 1;
        update();
      } finally {
        store.close();
      }
    } else {
      const dryRun = request.operation === "backfill" && request.dryRun;
      const targets = [];
      let targetError = false;
      for (const cameraId of cameraIds.filter(
        (id) => request.camera === "all" || request.camera === id,
      )) {
        try {
          const kinds = readTargets(cameraId, env);
          targets.push({ cameraId, kinds });
          progress.totalTargets += kinds.length;
        } catch {
          targetError = true;
          log(`${cameraId} の取得種別設定が無効です。`);
        }
      }
      update();
      const db = dryRun ? undefined : d1Database(readD1Config(env));
      if (db)
        await db.batch([
          { sql: "SELECT camera_id FROM linecross_hourly LIMIT 0" },
          { sql: "SELECT camera_id FROM heatmaps_hourly LIMIT 0" },
        ]);

      function onEvent(event: CollectionEvent) {
        const { camera, kind } = event;
        if (event.type === "target") {
          Object.assign(progress, {
            camera,
            kind,
            requestsDone: undefined,
            requestsTotal: undefined,
          });
        } else if (event.type === "plan") {
          report.plans.push(event);
          if (!dryRun)
            Object.assign(progress, {
              requestsDone: 0,
              requestsTotal: event.multi + Number(event.latest),
            });
        } else if (event.type === "progress") {
          Object.assign(progress, {
            requestsDone: event.completed,
            requestsTotal: event.total,
          });
        } else {
          report.targets.push(event);
          progress.completedTargets++;
          const counts = { ...event.counts };
          addCounts(counts, report.counts);
          Object.assign(report.counts, counts);
          report.counts.noData += event.noData;
          report.counts.records += event.records;
        }
        update();
      }
      exit = await collectHistory(targets, {
        action: request.operation,
        bounds: request.operation === "backfill" ? backfillBounds(request) : {},
        runtime,
        dryRun,
        db,
        env,
        log,
        onEvent,
      });
      if (targetError) exit = 1;
      if (exit === 0) error = null;
    }
  } catch (caught) {
    log(
      caught instanceof Error ? caught.message : "予期しない実行エラーです。",
    );
    exit = 1;
  }
  log(
    exit === 0 ? "ジョブが完了しました。" : (error ?? "ジョブが失敗しました。"),
  );
  jobs.finish(id, exit, error);
  return exit;
}
