import type { CameraId } from "../config.mts";
import type { NormalizedKind } from "../parse/csv.mts";

export const requestKinds = {
  linecross: "movcnt_info",
  heatmap_mov: "heatmap_mov_info",
  heatmap_loi: "heatmap_loi_info",
} as const satisfies Record<NormalizedKind, string>;

export function readTargets(
  camera: CameraId,
  env: Readonly<Record<string, string | undefined>>,
): NormalizedKind[] {
  const key = `IPRO_${camera.toUpperCase()}_HISTORY_KINDS`;
  const setting = env[key];
  if (setting === undefined) {
    return camera === "food"
      ? ["linecross"]
      : ["linecross", "heatmap_mov", "heatmap_loi"];
  }
  if (setting.trim() === "") {
    return [];
  }
  const kinds = setting.split(",").map((value) => value.trim());
  if (kinds.some((value) => !Object.hasOwn(requestKinds, value))) {
    throw new Error(`Invalid history kind in ${key}.`);
  }
  return [...new Set(kinds)] as NormalizedKind[];
}
