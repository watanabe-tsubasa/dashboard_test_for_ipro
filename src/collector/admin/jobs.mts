import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CameraId } from "../config.mts";
import type {
  Job,
  JobDetail,
  JobProgress,
  JobReport,
  JobRequest,
} from "./contract.mts";

type Value = string | number | null;
interface Statement {
  all(...values: Value[]): object[];
  get(...values: Value[]): object | undefined;
  run(...values: Value[]): { changes: number | bigint };
}
interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
type JobRow = Omit<Job, "request" | "progress" | "report"> & {
  request: string;
  progress: string | null;
  report: string | null;
  pid: number | null;
  identity: string | null;
};
const activeStates = "('queued','running')";
const maxLogs = 600;
const pageSize = 120;
const queuedTimeout = 45_000;
const maxMessage = 800;

export function jobPath() {
  return resolve("runtime/goal4/jobs/jobs.sqlite");
}

export function processIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (!fields[19] || ["Z", "X"].includes(fields[0])) return null;
      const boot = readFileSync(
        "/proc/sys/kernel/random/boot_id",
        "utf8",
      ).trim();
      return `${boot}:${fields[19]}`;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ESRCH"
      )
        return null;
    }
  }
  try {
    process.kill(pid, 0);
    return "pid";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "pid" : null;
  }
}

function decode(row: JobRow): Job {
  const {
    pid: _pid,
    identity: _identity,
    request,
    progress,
    report,
    ...job
  } = row;
  return {
    ...job,
    request: JSON.parse(request),
    progress: progress ? JSON.parse(progress) : null,
    report: report ? JSON.parse(report) : null,
  };
}

export function openJobs(
  file = jobPath(),
  {
    clock = Date.now,
    identity = processIdentity,
  }: { clock?: () => number; identity?: (pid: number) => string | null } = {},
) {
  const sqlite = process.getBuiltinModule("node:sqlite") as
    | { DatabaseSync: new (path: string) => Sqlite }
    | undefined;
  if (!sqlite) throw new Error("Node.js 22 SQLite is required.");
  mkdirSync(dirname(file), { mode: 0o700, recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL,
      createdAtUtc TEXT NOT NULL, startedAtUtc TEXT, finishedAtUtc TEXT, exitCode INTEGER,
      error TEXT, progress TEXT, report TEXT, pid INTEGER, identity TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS single_active_job ON jobs((1)) WHERE state IN ${activeStates};
    CREATE TABLE IF NOT EXISTS logs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, jobId TEXT NOT NULL REFERENCES jobs(id), message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS logs_job_seq ON logs(jobId, seq);
  `);
  const iso = () => new Date(clock()).toISOString();
  const read = (id: string) =>
    db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined;
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function log(id: string, message: string) {
    db.prepare("INSERT INTO logs(jobId,message) VALUES(?,?)").run(
      id,
      message.slice(0, maxMessage),
    );
    db.prepare(
      "DELETE FROM logs WHERE jobId=? AND seq <= (SELECT seq FROM logs WHERE jobId=? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
    ).run(id, id, maxLogs);
  }
  function findActive() {
    const row = db
      .prepare(`SELECT * FROM jobs WHERE state IN ${activeStates}`)
      .get() as JobRow | undefined;
    if (!row) return null;
    const expired =
      row.state === "queued" &&
      clock() - Date.parse(row.createdAtUtc) >= queuedTimeout;
    const owner = row.pid ? identity(row.pid) : null;
    const gone =
      row.state === "running" &&
      (!owner ||
        (row.identity !== "pid" && owner !== "pid" && row.identity !== owner));
    if (!expired && !gone) return decode(row);
    const message = expired
      ? "ジョブの起動を確認できませんでした。"
      : "実行プロセスが停止しました。";
    db.prepare(
      "UPDATE jobs SET state='interrupted',finishedAtUtc=?,error=? WHERE id=?",
    ).run(iso(), message, row.id);
    log(row.id, message);
    return null;
  }
  return {
    close: () => db.close(),
    active: () => transaction(findActive),
    enqueue(request: JobRequest) {
      return transaction(() => {
        const active = findActive();
        if (active) return { accepted: false, job: active } as const;
        const id = randomUUID();
        db.prepare(
          "INSERT INTO jobs(id,request,state,createdAtUtc) VALUES(?,?,'queued',?)",
        ).run(id, JSON.stringify(request), iso());
        const row = read(id);
        if (!row) throw new Error("Job record missing.");
        return { accepted: true, job: decode(row) } as const;
      });
    },
    claim(id: string, pid = process.pid) {
      return transaction(() => {
        findActive();
        const owner = identity(pid);
        if (
          !owner ||
          !db
            .prepare(
              "UPDATE jobs SET state='running',startedAtUtc=?,pid=?,identity=? WHERE id=? AND state='queued'",
            )
            .run(iso(), pid, owner, id).changes
        )
          return null;
        const row = read(id);
        return row ? decode(row) : null;
      });
    },
    update(id: string, progress: JobProgress, report: JobReport) {
      db.prepare(
        "UPDATE jobs SET progress=?,report=? WHERE id=? AND state='running'",
      ).run(JSON.stringify(progress), JSON.stringify(report), id);
    },
    append(id: string, message: string) {
      transaction(() => log(id, message));
    },
    launchFailed(id: string) {
      return transaction(() => {
        const message = "ジョブ実行プロセスを起動できませんでした。";
        if (
          db
            .prepare(
              "UPDATE jobs SET state='failed',finishedAtUtc=?,exitCode=1,error=? WHERE id=? AND state='queued'",
            )
            .run(iso(), message, id).changes
        )
          log(id, message);
      });
    },
    finish(id: string, exitCode: number, error: string | null) {
      db.prepare(
        "UPDATE jobs SET state=?,finishedAtUtc=?,exitCode=?,error=? WHERE id=? AND state='running'",
      ).run(
        exitCode === 0 ? "succeeded" : "failed",
        iso(),
        exitCode,
        error,
        id,
      );
    },
    list() {
      return transaction(() => {
        findActive();
        return (
          db
            .prepare(
              "SELECT * FROM jobs ORDER BY createdAtUtc DESC,rowid DESC LIMIT 30",
            )
            .all() as JobRow[]
        ).map(decode);
      });
    },
    last(camera: CameraId, thumbnail: boolean) {
      const row = db
        .prepare(`
        SELECT * FROM jobs WHERE json_extract(request,'$.camera') IN (?,'all')
          AND (json_extract(request,'$.operation') = 'thumbnail') = ?
          AND COALESCE(json_extract(request,'$.dryRun'),0) = 0
          AND state IN ('succeeded','failed','interrupted')
        ORDER BY createdAtUtc DESC,rowid DESC LIMIT 1
      `)
        .get(camera, Number(thumbnail)) as JobRow | undefined;
      return row ? decode(row) : null;
    },
    detail(id: string, after?: number): JobDetail | null {
      return transaction(() => {
        findActive();
        const row = read(id);
        if (!row) return null;
        const logs = (
          after === undefined
            ? db
                .prepare(
                  "SELECT seq,message FROM logs WHERE jobId=? ORDER BY seq DESC LIMIT ?",
                )
                .all(id, pageSize)
                .reverse()
            : db
                .prepare(
                  "SELECT seq,message FROM logs WHERE jobId=? AND seq>? ORDER BY seq LIMIT ?",
                )
                .all(id, after, pageSize + 1)
        ) as JobDetail["logs"];
        const hasMore = logs.length > pageSize;
        if (hasMore) logs.pop();
        return {
          job: decode(row),
          logs,
          cursor: logs.at(-1)?.seq ?? after ?? 0,
          hasMore,
        };
      });
    },
  };
}
