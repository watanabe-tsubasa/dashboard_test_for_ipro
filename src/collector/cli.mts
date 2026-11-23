import { relative, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { cgiRequests } from "./cgi.mts";
import { cameraIds, readCameraConfig } from "./config.mts";
import { type HistoryWindow, historyQuery } from "./history.mts";
import { getCameraResponse } from "./iproClient.mts";
import { createRunDirectory, newRunId, saveResponse } from "./rawStore.mts";

const usage = `Usage:
  yarn probe [--camera food|island]
  yarn fetch [--camera food|island] [--include-images] [--from <UTC-or-JST> --to <UTC-or-JST>]`;

async function main(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        camera: { type: "string" },
        "include-images": { type: "boolean" },
        from: { type: "string" },
        to: { type: "string" },
      },
    });
  } catch {
    console.error(usage);
    return 2;
  }

  const [command] = parsed.positionals;
  const selected = parsed.values.camera;
  const includeImages = parsed.values["include-images"] === true;
  const { from, to } = parsed.values;
  const hasWindow = from !== undefined || to !== undefined;
  if (
    parsed.positionals.length !== 1 ||
    (command !== "probe" && command !== "fetch") ||
    (selected !== undefined && selected !== "food" && selected !== "island") ||
    (command === "probe" && (includeImages || hasWindow)) ||
    (hasWindow && (typeof from !== "string" || typeof to !== "string"))
  ) {
    console.error(usage);
    return 2;
  }

  let window: HistoryWindow | undefined;
  if (typeof from === "string" && typeof to === "string") {
    try {
      ({ window } = historyQuery(from, to));
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Invalid history window.",
      );
      return 2;
    }
  }

  try {
    loadEnvFile(".env.local");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Could not load .env.local.");
      return 2;
    }
  }

  const outputRoot = resolve("runtime/goal1");
  const requests = cgiRequests(command, includeImages, window);
  const runId = newRunId();
  let success = 0;
  let noData = 0;
  let failed = 0;
  let skipped = 0;

  for (const id of cameraIds.filter((id) => !selected || id === selected)) {
    const { camera, error } = readCameraConfig(id, process.env);
    if (!camera) {
      console.error(`${id} config_error — ${error}`);
      skipped += requests.length;
      continue;
    }

    let directory: string;
    try {
      directory = await createRunDirectory(outputRoot, id, runId);
    } catch {
      console.error(
        `${id} storage_error — Could not create the output directory.`,
      );
      skipped += requests.length;
      continue;
    }

    for (const request of requests) {
      const label = `${id} ${request.kind}:${request.mode}`;
      const response = await getCameraResponse(camera, request);
      const http = `HTTP ${response.status ?? "-"} ${response.bytesReceived} B`;
      try {
        const saved = await saveResponse(
          directory,
          camera,
          request,
          response,
          new Date().toISOString(),
        );
        const path = relative(
          process.cwd(),
          saved.bodyPath ?? saved.metadataPath,
        );
        const line = `${label} ${saved.result} ${http} ${path}`;
        if (saved.result === "success") {
          success++;
          console.log(line);
        } else if (saved.result === "no_data") {
          noData++;
          console.log(`${line} — ${saved.error?.message}`);
        } else {
          failed++;
          console.error(
            `${line} — ${saved.error?.type}: ${saved.error?.message}`,
          );
        }
      } catch {
        failed++;
        console.error(
          `${label} storage_error ${http} — Could not save camera output.`,
        );
      }
    }
  }

  console.log(
    `Summary: success=${success} no_data=${noData} failed=${failed} skipped=${skipped}`,
  );
  return failed || skipped ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch {
  console.error("Collector failed unexpectedly.");
  process.exitCode = 1;
}
