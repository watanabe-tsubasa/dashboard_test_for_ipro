import { cameraIds } from "../config.mts";
import { historyInstant } from "../history.mts";
import type { JobRequest } from "./contract.mts";

export class InputError extends Error {}

const day = 86_400_000;

export function validId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}

function dateMillis(date: unknown): number {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new InputError("日付は YYYY-MM-DD で指定してください。");
  }
  try {
    return historyInstant(`${date}T00:00+09:00`);
  } catch {
    throw new InputError("実在する日付を指定してください。");
  }
}

export function backfillBounds(
  request: Extract<JobRequest, { operation: "backfill" }>,
) {
  return request.from && request.to
    ? { from: dateMillis(request.from), to: dateMillis(request.to) + day }
    : {};
}

export type Submission = { request: JobRequest } | { retryOf: string };

export function readSubmission(input: unknown, now = Date.now()): Submission {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InputError("無効な操作です。");
  }
  const fields = input as Record<string, unknown>;
  const keys = Object.keys(fields);
  const { operation, camera, from, to, dryRun, confirmed, retryOf } = fields;
  if (keys.length === 1 && typeof retryOf === "string" && validId(retryOf)) {
    return { retryOf };
  }
  const selected = cameraIds.find((id) => camera === id);
  const scope = selected ?? (camera === "all" ? "all" : undefined);
  if (!scope) throw new InputError("対象カメラを選択してください。");
  if (operation === "sync" && keys.length === 2)
    return { request: { operation, camera: scope } };
  if (operation === "thumbnail" && selected && keys.length === 2)
    return { request: { operation, camera: selected } };
  if (
    operation !== "backfill" ||
    keys.some(
      (key) =>
        !["operation", "camera", "from", "to", "dryRun", "confirmed"].includes(
          key,
        ),
    ) ||
    (dryRun !== undefined && typeof dryRun !== "boolean") ||
    (confirmed !== undefined && typeof confirmed !== "boolean")
  ) {
    throw new InputError("無効な操作または入力項目です。");
  }
  if (dryRun !== true && confirmed !== true) {
    throw new InputError("対象範囲を確認してから履歴取得を開始してください。");
  }
  if (from === undefined && to === undefined) {
    return { request: { operation, camera: scope, dryRun: dryRun === true } };
  }
  if (typeof from !== "string" || typeof to !== "string") {
    throw new InputError("開始日と終了日を両方指定してください。");
  }
  const start = dateMillis(from);
  const end = dateMillis(to);
  if (start > end) throw new InputError("終了日は開始日以降にしてください。");
  if (end > now) throw new InputError("未来の日付は指定できません。");
  if ((end - start) / day + 1 > 732)
    throw new InputError("指定できる期間は732日以内です。");
  return {
    request: { operation, camera: scope, from, to, dryRun: dryRun === true },
  };
}
