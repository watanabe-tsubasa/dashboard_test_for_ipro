import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { cameraIds } from "../config.mts";
import { readR2Config } from "./config.mts";
import { ThumbnailError } from "./failure.mts";
import { createR2Store } from "./storage.mts";
import { refreshCameraThumbnail, type ThumbnailResult } from "./thumbnail.mts";

const usage =
  "Usage: yarn r2:thumbnail --camera food|island|all [--dry-run] [--source-file <capture.bin>]";

async function main(args: string[]): Promise<number> {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values } = parseArgs({
      args,
      options: {
        camera: { type: "string" },
        "dry-run": { type: "boolean" },
        "source-file": { type: "string" },
      },
    }));
  } catch {
    console.error(usage);
    return 2;
  }
  const { camera, "dry-run": dryRun, "source-file": sourceFile } = values;
  const selected = cameraIds.find((id) => id === camera);
  if (
    (!selected && camera !== "all") ||
    (sourceFile !== undefined &&
      (!selected || typeof sourceFile !== "string" || !sourceFile))
  ) {
    console.error(usage);
    return 2;
  }
  try {
    loadEnvFile(".env.local");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Could not load .env.local.");
      return 2;
    }
  }
  let store: ReturnType<typeof createR2Store> | undefined;
  try {
    const config = readR2Config(process.env, dryRun === true);
    if (config) store = createR2Store(config);
  } catch (error) {
    console.error(
      error instanceof ThumbnailError
        ? error.message
        : "Could not configure R2.",
    );
    return 2;
  }

  const counts: Record<ThumbnailResult["status"], number> = {
    uploaded: 0,
    unchanged: 0,
    no_data: 0,
    dry_run: 0,
    failed: 0,
    uncertain: 0,
  };
  try {
    for (const id of selected ? [selected] : cameraIds) {
      const result = await refreshCameraThumbnail(id, {
        env: process.env,
        runtime: resolve("runtime"),
        store,
        dryRun: dryRun === true,
        sourceFile: typeof sourceFile === "string" ? sourceFile : undefined,
      });
      counts[result.status]++;
      const fields = [result.camera, result.status, `key=${result.key}`];
      if (result.source)
        fields.push(`cgi=${result.source.kind}:${result.source.mode}`);
      if (result.image) {
        fields.push(
          `bytes=${result.image.bytes}`,
          `sha256=${result.image.sha256}`,
          `retrieved=${result.image.retrievedAtUtc}`,
        );
        if (result.image.sourceStartUtc && result.image.sourceEndUtc) {
          fields.push(
            `source_period=${result.image.sourceStartUtc}/${result.image.sourceEndUtc}`,
          );
        }
        fields.push(`capture=${result.image.rawFile}`);
      }
      if (result.lastModifiedUtc)
        fields.push(`r2_last_modified=${result.lastModifiedUtc}`);
      if (result.status === "dry_run") fields.push(`plan=${result.plan}`);
      if (result.status === "no_data")
        fields.push(
          `code=${result.noDataCode}`,
          `retrieved=${result.retrievedAtUtc}`,
          `capture=${result.rawFile}`,
        );
      if (result.status === "failed" || result.status === "uncertain") {
        console.error(
          fields.join(" "),
          "—",
          result.error.code,
          result.error.message,
        );
      } else {
        console.log(fields.join(" "));
      }
    }
    console.log(
      "Summary",
      Object.entries(counts)
        .map(([status, count]) => `${status}=${count}`)
        .join(" "),
    );
    return counts.failed || counts.uncertain ? 1 : 0;
  } finally {
    store?.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch {
  console.error("Thumbnail command failed unexpectedly.");
  process.exitCode = 1;
}
