import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { cameraIds } from "../config.mts";
import { capturePath, discoverCaptures, normalizeCapture } from "./store.mts";

const usage =
  "Usage: yarn parse [--camera food|island | --file runtime/goal1/<camera>/<run-id>/<capture>.bin]";

async function main(args: string[]): Promise<number> {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values } = parseArgs({
      args,
      options: { camera: { type: "string" }, file: { type: "string" } },
    }));
  } catch {
    console.error(usage);
    return 2;
  }
  const camera = cameraIds.find((id) => id === values.camera);
  if (
    (values.camera !== undefined && !camera) ||
    (camera && values.file !== undefined) ||
    (values.file !== undefined &&
      (typeof values.file !== "string" || !values.file))
  ) {
    console.error(usage);
    return 2;
  }
  const root = resolve("runtime/goal1");
  const output = resolve("runtime/goal2");
  const captures =
    typeof values.file === "string"
      ? [capturePath(root, values.file)]
      : await discoverCaptures(root, camera ? [camera] : cameraIds);
  if (!captures.length) {
    console.error("No saved Goal1 captures found.");
    return 1;
  }

  const totals = new Map(
    cameraIds.map((id) => [
      id,
      { success: 0, noData: 0, failed: 0, records: 0, images: 0 },
    ]),
  );
  for (const capture of captures) {
    const summary = totals.get(capture.cameraId);
    if (!summary) continue;
    const label = `${capture.cameraId} ${capture.runId}/${capture.stem}`;
    try {
      const result = await normalizeCapture(capture, output);
      switch (result.status) {
        case "camera_error":
          summary.failed++;
          console.error(`${label} camera_error (No Data(3).)`);
          break;
        case "no_data":
          summary.noData++;
          console.log(
            `${label} no_data (${"code" in result ? result.code : result.reason})`,
          );
          break;
        case "range":
          summary.success++;
          console.log(
            `${label} range ${result.dataFromUtc} – ${result.dataUntilUtc} (${result.precision})`,
          );
          break;
        case "data":
          summary.success++;
          summary.records += result.records.length;
          summary.images += result.images.length;
          console.log(
            `${label} success records=${result.records.length} jpeg=${result.images.length}${result.filteredRecords === undefined ? "" : ` filtered=${result.filteredRecords}`}`,
          );
          for (const record of result.records) {
            const { startUtc, endUtc, intervalMinutes } = record.period;
            const statistics =
              record.kind === "linecross"
                ? `configured_lines=${record.lines.filter((line) => line.configured).length}`
                : `max=${record.statistics.max} nonzero=${record.statistics.nonZeroCells}`;
            console.log(
              `  ${record.kind} ${startUtc} – ${endUtc} (${intervalMinutes} min) ${statistics}`,
            );
          }
      }
    } catch (error) {
      summary.failed++;
      console.error(
        `${label} parse_error — ${error instanceof Error ? error.message : "Unexpected error."}`,
      );
    }
  }

  for (const [id, counts] of totals) {
    if (counts.success || counts.noData || counts.failed) {
      console.log(
        `${id} summary success=${counts.success} no_data=${counts.noData} failed=${counts.failed} records=${counts.records} jpeg=${counts.images}`,
      );
    }
  }
  return [...totals.values()].some((counts) => counts.failed) ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch {
  console.error("Could not locate the requested Goal1 captures.");
  process.exitCode = 1;
}
