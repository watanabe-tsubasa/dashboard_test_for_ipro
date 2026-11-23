import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Database, Row } from "./database.mts";

interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: Array<string | number>): Row[] };
  close(): void;
}

export async function localDatabase(
  path: string,
  { create = false, readOnly = false } = {},
): Promise<Database & { close(): void }> {
  const sqlite = process.getBuiltinModule("node:sqlite") as
    | {
        DatabaseSync: new (
          file: string,
          options: { readOnly: boolean },
        ) => SqliteConnection;
      }
    | undefined;
  if (!sqlite)
    throw new Error("Local verification requires Node.js 22 with node:sqlite.");
  if (create) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let db: SqliteConnection;
  try {
    db = new sqlite.DatabaseSync(path, { readOnly });
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  } catch {
    throw new Error("Could not open the local SQLite database.");
  }
  return {
    async batch(statements) {
      try {
        db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
        const results = statements.map(({ sql, params }) =>
          db.prepare(sql).all(...(params ?? [])),
        );
        db.exec("COMMIT");
        return results;
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw new Error(
          "Local SQLite batch failed. Check schema and input constraints.",
        );
      }
    },
    close: () => db.close(),
  };
}
