"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type AdminStatus,
  type CameraStatus,
  isActive,
  type Job,
  type JobDetail,
  type JobRequest,
  type MeasurementStatus,
  type Selection,
} from "@/src/collector/admin/contract.mts";
import styles from "./dashboard.module.css";
import { apiRoot, useCollector } from "./useCollector";

const labels = {
  linecross: "ラインクロス",
  heatmap_mov: "通過",
  heatmap_loi: "滞留",
};
const cameras = { food: "Food", island: "Island", all: "すべてのカメラ" };
const thumbnailOutcomes = {
  uploaded: "画像更新済み",
  unchanged: "同一画像のため省略",
  no_data: "データなし",
  failed: "画像更新失敗",
  uncertain: "更新結果未確認",
};
const jobStates = {
  queued: "待機中",
  running: "実行中",
  succeeded: "完了",
  failed: "失敗",
  interrupted: "中断",
};
const formatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const count = new Intl.NumberFormat("ja-JP");

function time(value?: string | null) {
  return value ? `${formatter.format(new Date(value))} JST` : "—";
}

function operation(request: JobRequest) {
  if (request.operation === "thumbnail") return "画像を更新";
  if (request.operation === "sync") return "最新データを同期";
  return request.dryRun ? "取得計画" : "履歴を取得";
}

function StateBadge({ job }: { job: Job }) {
  const uncertain = job.report?.thumbnail?.outcome === "uncertain";
  const state = uncertain ? "interrupted" : job.state;
  return (
    <span className={`${styles.badge} ${styles[state]}`}>
      {uncertain ? "結果未確認" : jobStates[job.state]}
    </span>
  );
}

function Connection({
  name,
  ready,
}: {
  name: string;
  ready: boolean | undefined;
}) {
  return (
    <span className={styles.connection}>
      <span className={ready ? styles.readyDot : styles.idleDot} />
      {name}
      <strong>
        {ready === undefined ? "確認中" : ready ? "設定済み" : "未設定"}
      </strong>
    </span>
  );
}

function CameraSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: Selection;
  onChange: (value: Selection) => void;
}) {
  return (
    <label className={styles.field} htmlFor={id}>
      対象カメラ
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as Selection)}
      >
        <option value="all">{cameras.all}</option>
        <option value="food">Food</option>
        <option value="island">Island</option>
      </select>
    </label>
  );
}

function Thumbnail({
  camera,
  configured,
}: {
  camera: CameraStatus;
  configured: boolean;
}) {
  const [image, setImage] = useState<{
    url?: string;
    updated?: string;
    message: string;
  }>({ message: "保存済み画像を取得中…" });
  const verified = camera.lastThumbnail?.report?.thumbnail?.outcome;
  const revision =
    verified === "uploaded" || verified === "unchanged"
      ? camera.lastThumbnail?.id
      : undefined;
  useEffect(() => {
    if (!configured) return;
    const controller = new AbortController();
    let url: string | undefined;
    async function load() {
      try {
        const response = await fetch(
          `${apiRoot}/thumbnails/${camera.id}${revision ? `?revision=${revision}` : ""}`,
          {
            signal: controller.signal,
            cache: "no-store",
          },
        );
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setImage({
            message:
              response.status === 404
                ? "保存済み画像がありません"
                : response.status === 403
                  ? "画像の読み取り権限を確認してください"
                  : "画像を取得できませんでした",
          });
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setImage({
          url,
          updated: response.headers.get("Last-Modified") ?? undefined,
          message: "画像を表示できませんでした",
        });
      } catch {
        if (!controller.signal.aborted)
          setImage({ message: "画像を取得できませんでした" });
      }
    }
    void load();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [camera.id, configured, revision]);

  return (
    <figure className={styles.figure}>
      <div className={styles.imageFrame}>
        {configured && image.url ? (
          // Blob URLs are returned by the local image proxy.
          // biome-ignore lint/performance/noImgElement: This image uses a same-origin Blob URL
          <img
            src={image.url}
            alt={`${camera.name} のJPEGインデックス画像`}
            onError={() => setImage({ message: "画像を表示できませんでした" })}
          />
        ) : (
          <div className={styles.placeholder}>
            <span className={styles.imageSymbol} aria-hidden="true" />
            {configured ? image.message : "R2が未設定です"}
          </div>
        )}
      </div>
      <figcaption>
        <span>JPEGインデックス画像</span>
        <span>R2更新 {time(image.updated)}</span>
      </figcaption>
    </figure>
  );
}

function CameraCard({
  camera,
  measurement,
  r2,
  busy,
  updating,
  onUpdate,
}: {
  camera: CameraStatus;
  measurement?: MeasurementStatus;
  r2: boolean;
  busy: boolean;
  updating: boolean;
  onUpdate: () => void;
}) {
  const last = camera.lastCollection;
  const thumb = camera.lastThumbnail;
  const outcome = thumb?.report?.thumbnail?.outcome;
  return (
    <article className={styles.card}>
      <div className={styles.cameraHeading}>
        <div>
          <h3>{camera.name}</h3>
          <code>{camera.id}</code>
        </div>
        <Connection name="カメラ" ready={camera.configured} />
      </div>
      <Thumbnail camera={camera} configured={r2} />
      <div className={styles.cameraInfo}>
        <div className={styles.infoLine}>
          <span>履歴取得種別</span>
          <div className={styles.chips}>
            {!camera.historySettingsValid
              ? "設定エラー"
              : camera.kinds.length
                ? camera.kinds.map((kind) => (
                    <span key={kind}>{labels[kind]}</span>
                  ))
                : "未選択"}
          </div>
        </div>
        <div className={styles.infoLine}>
          <span>前回の収集</span>
          <span>
            {last ? (
              <>
                <StateBadge job={last} /> {time(last.finishedAtUtc)}
              </>
            ) : (
              "実行履歴なし"
            )}
          </span>
        </div>
        {measurement?.state === "ready" && measurement.rows.length > 0 ? (
          <div className={styles.measurementRows}>
            {measurement.rows.map(({ kind, rows, newestStartUtc }) => (
              <div key={kind}>
                <span>{labels[kind]}</span>
                <strong>{count.format(rows)} 行</strong>
                <small>{time(newestStartUtc)}</small>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.muted}>
            {measurement?.state === "unavailable"
              ? "D1の保存状況を取得できません"
              : measurement?.state === "ready"
                ? "D1に保存済み区間がありません"
                : "D1の保存状況は未確認"}
          </p>
        )}
        {measurement?.state === "ready" && measurement.rows.length > 0 && (
          <p className={styles.muted}>保存行数と最新区間の開始時刻</p>
        )}
      </div>
      <div className={styles.cameraFooter}>
        <span aria-live="polite">
          {updating
            ? "画像を確認中…"
            : outcome
              ? thumbnailOutcomes[outcome]
              : thumb
                ? jobStates[thumb.state]
                : "画像更新履歴なし"}
        </span>
        <button
          type="button"
          className={styles.secondary}
          onClick={onUpdate}
          disabled={
            busy || !r2 || !camera.configured || !camera.thumbnailSettingsValid
          }
        >
          画像を更新
        </button>
      </div>
    </article>
  );
}

function Progress({ job }: { job: Job }) {
  const progress = job.progress;
  const total = progress?.requestsTotal || progress?.totalTargets;
  const done = progress?.requestsTotal
    ? (progress.requestsDone ?? 0)
    : (progress?.completedTargets ?? 0);
  return (
    <div className={styles.progress}>
      <div>
        <strong>
          {progress?.camera
            ? cameras[progress.camera]
            : cameras[job.request.camera]}
          {progress?.kind ? ` · ${labels[progress.kind]}` : ""}
        </strong>
        <span>
          {total
            ? `${done} / ${total} ${progress?.requestsTotal ? "リクエスト" : "対象"}`
            : "起動中"}
        </span>
      </div>
      {total ? (
        <progress aria-label="処理進捗" value={done} max={total} />
      ) : (
        <progress aria-label="処理進捗" />
      )}
    </div>
  );
}

function PlanResult({
  job,
  busy,
  onConfirm,
}: {
  job: Job;
  busy: boolean;
  onConfirm: () => void;
}) {
  const plans = job.report?.plans ?? [];
  return (
    <div className={styles.plan}>
      <div className={styles.planHeading}>
        <strong>{cameras[job.request.camera]}の取得計画</strong>
        <StateBadge job={job} />
      </div>
      {job.request.operation === "backfill" && (
        <p className={styles.muted}>
          {job.request.from
            ? `${job.request.from} ～ ${job.request.to} JST`
            : "実機の保持期間全体"}
        </p>
      )}
      {plans.length ? (
        <>
          <ul>
            {plans.map((plan) => (
              <li key={`${plan.camera}-${plan.kind}`}>
                <strong>
                  {cameras[plan.camera]} · {labels[plan.kind]}
                </strong>
                <span>
                  {time(plan.startUtc)} ～ {time(plan.endUtc)}
                </span>
                <span>{plan.multi} リクエスト</span>
              </li>
            ))}
          </ul>
          <p className={styles.muted}>
            取得範囲を確認してからD1への保存を開始します。
          </p>
          <button
            type="button"
            className={styles.primary}
            disabled={busy || job.state !== "succeeded"}
            onClick={onConfirm}
          >
            この範囲で履歴を取得
          </button>
        </>
      ) : (
        <p className={styles.muted}>
          {job.state === "succeeded"
            ? "指定範囲に取得可能な履歴がありません。"
            : "計画の詳細は実行ログで確認できます。"}
        </p>
      )}
    </div>
  );
}

function HistoryDetail({
  detail,
  busy,
  retry,
}: {
  detail: JobDetail | null;
  busy: boolean;
  retry: (id: string) => void;
}) {
  const [follow, setFollow] = useState(true);
  const [copyMessage, setCopyMessage] = useState("");
  const log = useRef<HTMLTextAreaElement | null>(null);
  const cursor = detail?.cursor;
  useEffect(() => {
    if (cursor !== undefined && follow && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [cursor, follow]);
  if (!detail)
    return (
      <div className={styles.detailEmpty}>
        実行するか、履歴からジョブを選択してください。
      </div>
    );
  const { job, logs } = detail;
  const counters = job.report?.counts;
  const thumbnail = job.report?.thumbnail;
  return (
    <div className={styles.detail}>
      <div className={styles.detailTitle}>
        <div>
          <h3>{operation(job.request)}</h3>
          <p>
            {cameras[job.request.camera]}
            {job.request.operation === "backfill" && job.request.from
              ? ` · ${job.request.from} ～ ${job.request.to} JST`
              : ""}
          </p>
        </div>
        <StateBadge job={job} />
      </div>
      <div className={styles.timestamps}>
        <span>開始 {time(job.startedAtUtc)}</span>
        <span>終了 {time(job.finishedAtUtc)}</span>
      </div>
      {isActive(job) && <Progress job={job} />}
      {job.error && (
        <output className={styles.errorBox}>
          {job.error}
          {thumbnail?.errorCode ? ` (${thumbnail.errorCode})` : ""}
        </output>
      )}
      {thumbnail ? (
        <div className={styles.metrics}>
          <span>{thumbnailOutcomes[thumbnail.outcome]}</span>
          {thumbnail.bytes !== undefined && (
            <span>{count.format(thumbnail.bytes)} B</span>
          )}
          <span>取得 {time(thumbnail.retrievedAtUtc)}</span>
          <span>R2更新 {time(thumbnail.lastModifiedUtc)}</span>
        </div>
      ) : (
        counters && (
          <dl className={styles.metrics}>
            {(
              [
                ["追加", counters.inserted],
                ["更新", counters.updated],
                ["変更なし", counters.unchanged],
                ["データなし", counters.noData],
                ["失敗", counters.failures],
                ["書込未確認", counters.unconfirmed],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{count.format(value)}</dd>
              </div>
            ))}
          </dl>
        )
      )}
      <div className={styles.logToolbar}>
        <strong>実行ログ</strong>
        <label>
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />{" "}
          自動スクロール
        </label>
        <button
          type="button"
          className={styles.textButton}
          disabled={!logs.length}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                logs.map(({ message }) => message).join("\n"),
              );
              setCopyMessage("コピー済み");
            } catch {
              setCopyMessage("コピーできませんでした");
            }
          }}
        >
          コピー
        </button>
        <output className={styles.muted}>{copyMessage}</output>
      </div>
      <textarea
        className={styles.logs}
        ref={log}
        readOnly
        rows={5}
        aria-label="実行ログ"
        value={
          logs.length
            ? logs.map(({ message }) => message).join("\n")
            : "ログはまだありません。"
        }
      />

      {(job.state === "failed" || job.state === "interrupted") && (
        <button
          type="button"
          className={styles.secondary}
          disabled={busy}
          onClick={() => retry(job.id)}
        >
          同じ条件で再試行
        </button>
      )}
    </div>
  );
}

function CameraCards({
  status,
  busy,
  submit,
  measurements,
}: {
  status: AdminStatus | null;
  busy: boolean;
  submit: (payload: object) => void;
  measurements: ReturnType<typeof useCollector>["measurements"];
}) {
  if (!status) return <p className={styles.muted}>カメラの設定を読み込み中…</p>;
  return (
    <div className={styles.cameraGrid}>
      {status.cameras.map((camera) => (
        <CameraCard
          key={camera.id}
          camera={camera}
          measurement={measurements?.[camera.id]}
          r2={status.r2Configured}
          busy={busy}
          updating={
            status.activeJob?.request.operation === "thumbnail" &&
            status.activeJob.request.camera === camera.id
          }
          onUpdate={() => submit({ operation: "thumbnail", camera: camera.id })}
        />
      ))}
    </div>
  );
}

export default function Dashboard() {
  const {
    status,
    jobs,
    detail,
    measurements,
    pollError,
    actionError,
    submitting,
    select,
    submit,
  } = useCollector();
  const [scope, setScope] = useState<Selection>("all");
  const [historyScope, setHistoryScope] = useState<Selection>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const active = status?.activeJob;
  const busy = submitting || isActive(active);
  const plan = jobs.find(
    ({ request }) => request.operation === "backfill" && request.dryRun,
  );
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const camerasReady = status
    ? status.cameras.every(({ configured }) => configured)
    : undefined;

  function planHistory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit({
      operation: "backfill",
      camera: historyScope,
      dryRun: true,
      ...(from || to ? { from, to } : {}),
    });
  }

  return (
    <div className={styles.shell} lang="ja">
      <header className={styles.masthead}>
        <div className={styles.topbar}>
          <div className={styles.brand}>
            <span className={styles.brandIcon} aria-hidden="true" />
            <div>
              <h1>i-PRO データ収集管理</h1>
              <p>ローカル管理</p>
            </div>
          </div>
          <div className={styles.connections}>
            <Connection name="カメラ" ready={camerasReady} />
            <Connection name="D1" ready={status?.d1Configured} />
            <Connection name="R2" ready={status?.r2Configured} />
          </div>
        </div>
      </header>
      <main className={styles.main}>
        {(pollError || actionError) && (
          <div role="alert" className={styles.errorBox}>
            {actionError || pollError}
          </div>
        )}
        {active && (
          <div className={styles.activeBar}>
            <output>
              <span className={styles.activeDot} />
              <strong>{operation(active.request)}</strong>{" "}
              <StateBadge job={active} />
            </output>
            <span>
              {cameras[active.request.camera]}
              {active.progress?.kind
                ? ` · ${labels[active.progress.kind]}`
                : ""}
            </span>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => {
                select(active.id);
                document
                  .getElementById("execution-history")
                  ?.scrollIntoView({ block: "start" });
              }}
            >
              進捗を表示
            </button>
          </div>
        )}
        <section aria-labelledby="operations-heading">
          <h2 id="operations-heading">収集操作</h2>
          <div className={styles.operations}>
            <form
              className={`${styles.card} ${styles.syncCard}`}
              onSubmit={(event) => {
                event.preventDefault();
                void submit({ operation: "sync", camera: scope });
              }}
            >
              <div>
                <h3>最新データを同期</h3>
                <p>保存済み区間の続きと直近のデータをD1に取り込みます。</p>
              </div>
              <CameraSelect
                id="sync-camera"
                value={scope}
                onChange={setScope}
              />
              <button
                type="submit"
                className={styles.primary}
                disabled={busy || !status?.d1Configured}
              >
                同期を開始
              </button>
            </form>
            <form className={styles.card} onSubmit={planHistory}>
              <div>
                <h3>履歴を取得</h3>
                <p>日付を省略すると、カメラが保持している全期間が対象です。</p>
              </div>
              <div className={styles.historyFields}>
                <CameraSelect
                  id="backfill-camera"
                  value={historyScope}
                  onChange={setHistoryScope}
                />
                <label className={styles.field} htmlFor="from">
                  開始日（JST）
                  <input
                    id="from"
                    type="date"
                    value={from}
                    max={to || today}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </label>
                <label className={styles.field} htmlFor="to">
                  終了日（JST）
                  <input
                    id="to"
                    type="date"
                    value={to}
                    min={from || undefined}
                    max={today}
                    onChange={(event) => setTo(event.target.value)}
                  />
                </label>
              </div>
              <button
                type="submit"
                className={styles.secondary}
                disabled={busy || !status}
              >
                取得計画を確認
              </button>
            </form>
          </div>
          {plan && plan.request.operation === "backfill" && !isActive(plan) && (
            <PlanResult
              job={plan}
              busy={busy || !status?.d1Configured}
              onConfirm={() =>
                void submit({ ...plan.request, dryRun: false, confirmed: true })
              }
            />
          )}
        </section>
        <section aria-labelledby="camera-heading">
          <h2 id="camera-heading">カメラ</h2>
          <CameraCards
            status={status}
            busy={busy}
            measurements={measurements}
            submit={(input) => void submit(input)}
          />
        </section>
        <section id="execution-history" aria-labelledby="history-heading">
          <div className={styles.sectionHeading}>
            <h2 id="history-heading">実行履歴</h2>
            <span>
              保存済みデータの再投入はCLIの <code>yarn d1:import</code>
            </span>
          </div>
          <div className={`${styles.card} ${styles.historyGrid}`}>
            <ol className={styles.jobList}>
              {jobs.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    className={
                      detail?.job.id === job.id ? styles.selectedJob : undefined
                    }
                    aria-pressed={detail?.job.id === job.id}
                    onClick={() => select(job.id)}
                  >
                    <span>
                      <strong>{operation(job.request)}</strong>
                      <small>
                        {cameras[job.request.camera]} · {time(job.createdAtUtc)}
                      </small>
                    </span>
                    <StateBadge job={job} />
                  </button>
                </li>
              ))}
              {jobs.length === 0 && (
                <li className={styles.empty}>実行履歴はまだありません。</li>
              )}
            </ol>
            <HistoryDetail
              detail={detail}
              busy={busy}
              retry={(id) => void submit({ retryOf: id })}
            />
          </div>
        </section>
      </main>
    </div>
  );
}
