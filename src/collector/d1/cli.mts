import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { cameraIds } from "../config.mts";
import { collectHistory } from "./collect.mts";
import {
  type Database,
  d1Database,
  migrate,
  readD1Config,
} from "./database.mts";
import { importGoal2, type Target } from "./import.mts";
import { localDatabase } from "./local.mts";
import { readBounds } from "./planner.mts";
import { readTargets } from "./targets.mts";

const usage = `Usage:
  yarn d1:migrate [--local]
  yarn d1:import [--camera food|island] [--dry-run] [--local]
  yarn backfill [--camera food|island] [--from <UTC-or-JST>] [--to <UTC-or-JST>] [--dry-run] [--local]
  yarn sync [--camera food|island] [--from <UTC-or-JST>] [--to <UTC-or-JST>] [--dry-run] [--local]`;

async function main(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        camera: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        "dry-run": { type: "boolean" },
        local: { type: "boolean" },
      },
    });
  } catch {
    console.error(usage);
    return 2;
  }
  const [action] = parsed.positionals;
  const { camera, from, to, local, "dry-run": dryRun } = parsed.values;
  const selected = cameraIds.find((id) => id === camera);
  if (
    parsed.positionals.length !== 1 ||
    (action !== "backfill" &&
      action !== "sync" &&
      action !== "import" &&
      action !== "migrate") ||
    (camera !== undefined && !selected) ||
    ((action === "migrate" || action === "import") &&
      (from !== undefined || to !== undefined)) ||
    (action === "migrate" && (selected || dryRun))
  ) {
    console.error(usage);
    return 2;
  }

  let bounds: ReturnType<typeof readBounds>;
  try {
    bounds = readBounds(
      typeof from === "string" ? from : undefined,
      typeof to === "string" ? to : undefined,
    );
    try {
      loadEnvFile(".env.local");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Could not load .env.local.");
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid command settings.",
    );
    return 2;
  }

  const log = (message: string) => console.log(message);
  const targets: Target[] = [];
  let configFailed = false;
  if (action !== "migrate") {
    for (const cameraId of cameraIds.filter(
      (id) => !selected || id === selected,
    )) {
      try {
        const kinds = readTargets(cameraId, process.env);
        targets.push({ cameraId, kinds });
        log(`${cameraId} enabled=${kinds.join(",") || "none"}`);
      } catch (error) {
        console.error(
          `${cameraId} config_error — ${error instanceof Error ? error.message : "Invalid targets."}`,
        );
        configFailed = true;
      }
    }
    if (!targets.length) return 1;
  }

  const runtime = resolve("runtime");
  const localPath = join(runtime, "goal3-a", "history.sqlite");
  let db: Database | undefined;
  let sqlite: Awaited<ReturnType<typeof localDatabase>> | undefined;
  try {
    if (!dryRun || action === "sync") {
      if (local && action === "migrate") {
        sqlite = await localDatabase(localPath, { create: true });
      } else if (local) {
        const exists = await access(localPath).then(
          () => true,
          () => false,
        );
        if (exists)
          sqlite = await localDatabase(localPath, {
            readOnly: dryRun === true,
          });
        if (!exists && !dryRun)
          throw new Error("Run yarn d1:migrate --local first.");
      }
      if (local) {
        db = sqlite;
      } else if (!dryRun) {
        db = d1Database(readD1Config(process.env));
      } else {
        try {
          db = d1Database(readD1Config(process.env));
        } catch {
          log("D1 coverage unavailable; dry run plans from camera retention.");
        }
      }
    }
    if (action === "migrate" && db) {
      await migrate(db);
      log(`Schema applied to ${local ? "local SQLite" : "D1"}.`);
      return 0;
    }
    if (db && !dryRun) {
      await db.batch([
        {
          sql: "SELECT camera_id FROM linecross_hourly LIMIT 0",
        },
        {
          sql: "SELECT camera_id FROM heatmaps_hourly LIMIT 0",
        },
      ]);
    }

    const exit =
      action === "import"
        ? await importGoal2(join(runtime, "goal2"), targets, db, log)
        : action === "backfill" || action === "sync"
          ? await collectHistory(targets, {
              action,
              bounds,
              runtime,
              dryRun: dryRun === true,
              db,
              env: process.env,
              log,
            })
          : 1;
    return configFailed ? 1 : exit;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "History command failed.",
    );
    return 1;
  } finally {
    sqlite?.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch {
  console.error("History command failed unexpectedly.");
  process.exitCode = 1;
}
