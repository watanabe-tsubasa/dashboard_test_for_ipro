import { type CameraId, cameraIds, readCameraConfig } from "../config.mts";
import { type Database, d1Database, readD1Config } from "../d1/database.mts";
import { readTargets } from "../d1/targets.mts";
import { readR2Config } from "../r2/config.mts";
import { ThumbnailError } from "../r2/failure.mts";
import { maxJpegBytes, readThumbnailSource } from "../r2/source.mts";
import { createR2Store } from "../r2/storage.mts";
import { thumbnailKey } from "../r2/thumbnail.mts";
import type { AdminStatus, JobRequest, Measurements } from "./contract.mts";
import { InputError, readSubmission, validId } from "./input.mts";
import { openJobs } from "./jobs.mts";
import { launchJob } from "./launch.mts";
import { createRedactor } from "./redact.mts";

const noStore = { "Cache-Control": "no-store" };

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: noStore });
}

function allowed(request: Request, env: NodeJS.ProcessEnv, write = false) {
  const host = request.headers.get("host");
  if (!host || request.headers.get("sec-fetch-site") === "cross-site")
    return false;
  const local =
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) &&
    URL.canParse(`http://${host}`);
  const configured = env.IPRO_ADMIN_ALLOWED_ORIGIN;
  const privateOrigin =
    configured && URL.canParse(configured) ? new URL(configured) : null;
  const forwarded =
    privateOrigin?.protocol === "https:" &&
    privateOrigin.origin === configured &&
    privateOrigin.host === host;
  if (!local && !forwarded) return false;
  const origin = request.headers.get("origin");
  if (!origin) return !write;
  return Boolean(
    (local && origin === `http://${host}`) ||
      (forwarded && origin === configured),
  );
}

async function body(request: Request) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
    throw new InputError("JSON形式で送信してください。");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("操作を指定してください。");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel().catch(() => {});
      throw new InputError("入力が長すぎます。");
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new InputError("無効なJSONです。");
  }
}

function attempt<T>(callback: () => T): T | undefined {
  try {
    return callback();
  } catch {
    return undefined;
  }
}

function checkJob(request: JobRequest, env: NodeJS.ProcessEnv) {
  const settings = cameraIds
    .filter((id) => request.camera === "all" || request.camera === id)
    .filter((id) => readCameraConfig(id, env).camera);
  if (!settings.length)
    throw new InputError("対象カメラの接続設定を確認してください。");
  if (request.operation === "thumbnail") {
    if (
      !attempt(() => readR2Config(env)) ||
      !attempt(() => readThumbnailSource(request.camera, env))
    ) {
      throw new InputError("R2または画像取得元の設定を確認してください。");
    }
    return;
  }
  if (
    !settings.some(
      (id) => (attempt(() => readTargets(id, env))?.length ?? 0) > 0,
    )
  ) {
    throw new InputError("対象カメラの履歴取得種別を設定してください。");
  }
  if (
    !(request.operation === "backfill" && request.dryRun) &&
    !attempt(() => readD1Config(env))
  ) {
    throw new InputError("D1の接続設定を確認してください。");
  }
}

type ImageReader = (
  key: string,
  max: number,
) => Promise<{ data: Buffer; lastModifiedUtc?: string }>;

export function adminApi({
  env = process.env,
  open = openJobs,
  launch = launchJob,
  image,
  database,
}: {
  env?: NodeJS.ProcessEnv;
  open?: () => ReturnType<typeof openJobs>;
  launch?: (id: string) => Promise<void>;
  image?: ImageReader;
  database?: Database;
} = {}) {
  const reject = () => json({ error: "許可されていないアクセスです。" }, 403);
  const unavailable = () =>
    json({ error: "ジョブ情報を読み込めませんでした。" }, 503);
  function withJobs<T>(run: (jobs: ReturnType<typeof openJobs>) => T): T {
    const jobs = open();
    try {
      return run(jobs);
    } finally {
      jobs.close();
    }
  }

  return {
    status(request: Request) {
      if (!allowed(request, env)) return reject();
      try {
        const redact = createRedactor(env);
        const status: AdminStatus = withJobs((jobs) => ({
          activeJob: jobs.active(),
          d1Configured: Boolean(attempt(() => readD1Config(env))),
          r2Configured: Boolean(attempt(() => readR2Config(env))),
          cameras: cameraIds.map((id) => {
            const { camera } = readCameraConfig(id, env);
            const kinds = attempt(() => readTargets(id, env));
            return {
              id,
              name: redact(camera?.name ?? (id === "food" ? "Food" : "Island")),
              configured: Boolean(camera),
              kinds: kinds ?? [],
              historySettingsValid: kinds !== undefined,
              thumbnailSettingsValid: Boolean(
                attempt(() => readThumbnailSource(id, env)),
              ),
              lastCollection: jobs.last(id, false),
              lastThumbnail: jobs.last(id, true),
            };
          }),
        }));
        return json(status);
      } catch {
        return unavailable();
      }
    },
    list(request: Request) {
      if (!allowed(request, env)) return reject();
      try {
        return json({ jobs: withJobs((jobs) => jobs.list()) });
      } catch {
        return unavailable();
      }
    },
    detail(request: Request, id: string) {
      if (!allowed(request, env)) return reject();
      const cursor = new URL(request.url).searchParams.get("after");
      if (
        cursor !== null &&
        (!/^\d{1,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
      ) {
        return json({ error: "無効なログ位置です。" }, 400);
      }
      if (!validId(id)) return json({ error: "ジョブが見つかりません。" }, 404);
      try {
        const detail = withJobs((jobs) =>
          jobs.detail(id, cursor === null ? undefined : Number(cursor)),
        );
        return detail
          ? json(detail)
          : json({ error: "ジョブが見つかりません。" }, 404);
      } catch {
        return unavailable();
      }
    },
    async start(request: Request) {
      if (!allowed(request, env, true)) return reject();
      try {
        const submission = readSubmission(await body(request));
        const jobRequest =
          "retryOf" in submission
            ? withJobs((jobs) => {
                const previous = jobs.detail(submission.retryOf)?.job;
                if (
                  !previous ||
                  (previous.state !== "failed" &&
                    previous.state !== "interrupted")
                ) {
                  throw new InputError(
                    "再試行できるジョブを選択してください。",
                  );
                }
                return previous.request;
              })
            : submission.request;
        checkJob(jobRequest, env);
        const queued = withJobs((jobs) => jobs.enqueue(jobRequest));
        if (!queued.accepted)
          return json(
            { jobId: queued.job.id, error: "別のジョブを実行中です。" },
            409,
          );
        try {
          await launch(queued.job.id);
        } catch {
          withJobs((jobs) => jobs.launchFailed(queued.job.id));
          return json(
            { jobId: queued.job.id, error: "ジョブを起動できませんでした。" },
            503,
          );
        }
        return json({ jobId: queued.job.id }, 202);
      } catch (error) {
        return error instanceof InputError
          ? json({ error: error.message }, 400)
          : unavailable();
      }
    },
    async measurements(request: Request) {
      if (!allowed(request, env)) return reject();
      const config = attempt(() => readD1Config(env));
      if (!config && !database)
        return json({
          food: { state: "not_configured" },
          island: { state: "not_configured" },
        });
      try {
        const db = database ?? (config && d1Database(config));
        if (!db) throw new Error();
        const rows = await db.batch([
          {
            sql: "SELECT camera_id, 'linecross' AS kind, COUNT(*) AS rows, MAX(start_utc) AS newest FROM linecross_hourly GROUP BY camera_id",
          },
          {
            sql: "SELECT camera_id, kind, COUNT(*) AS rows, MAX(start_utc) AS newest FROM heatmaps_hourly GROUP BY camera_id, kind",
          },
        ]);
        const result: Measurements = {
          food: { state: "ready", rows: [] },
          island: { state: "ready", rows: [] },
        };
        for (const row of rows.flat()) {
          const id = cameraIds.find((camera) => camera === row.camera_id);
          const { kind, rows, newest } = row;
          if (
            !id ||
            (kind !== "linecross" &&
              kind !== "heatmap_mov" &&
              kind !== "heatmap_loi") ||
            typeof rows !== "number" ||
            typeof newest !== "string" ||
            !Number.isFinite(Date.parse(newest))
          )
            continue;
          const current = result[id];
          if (current.state === "ready")
            current.rows.push({
              kind,
              rows,
              newestStartUtc: new Date(newest).toISOString(),
            });
        }
        return json(result);
      } catch {
        return json({
          food: { state: "unavailable" },
          island: { state: "unavailable" },
        });
      }
    },
    async thumbnail(request: Request, camera: string) {
      if (!allowed(request, env)) return reject();
      if (!cameraIds.includes(camera as CameraId))
        return json({ error: "カメラが見つかりません。" }, 404);
      const config = attempt(() => readR2Config(env));
      if (!config && !image)
        return json({ error: "R2の設定がありません。" }, 503);
      try {
        const key = thumbnailKey(camera);
        const store = !image && config ? createR2Store(config) : null;
        try {
          const read = image ?? store?.readImage;
          if (!read) throw new Error();
          const result = await read(key, maxJpegBytes);
          const headers = new Headers({
            ...noStore,
            "Content-Type": "image/jpeg",
            "X-Content-Type-Options": "nosniff",
          });
          if (
            result.lastModifiedUtc &&
            Number.isFinite(Date.parse(result.lastModifiedUtc))
          ) {
            headers.set(
              "Last-Modified",
              new Date(result.lastModifiedUtc).toUTCString(),
            );
          }
          return new Response(new Uint8Array(result.data), { headers });
        } finally {
          store?.close();
        }
      } catch (error) {
        if (error instanceof ThumbnailError && error.code === "r2_not_found")
          return json({ error: "保存済み画像がありません。" }, 404);
        if (error instanceof ThumbnailError && error.code === "r2_permissions")
          return json(
            { error: "R2の画像読み取り権限を確認してください。" },
            403,
          );
        return json({ error: "R2の画像を取得できませんでした。" }, 502);
      }
    },
  };
}
