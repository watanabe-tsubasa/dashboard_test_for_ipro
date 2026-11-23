import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { CameraId } from "../config.mts";
import { readCameraConfig } from "../config.mts";
import { type CameraResponse, getCameraResponse } from "../iproClient.mts";
import { parseResponse } from "../parse/response.mts";
import { capturePath, readCapture } from "../parse/store.mts";
import { createRunDirectory, newRunId, saveResponse } from "../rawStore.mts";
import { ThumbnailError } from "./failure.mts";

const sources = {
  movcnt: { kind: "movcnt", mode: "latest" },
  heatmap_mov: { kind: "heatmap_mov", mode: "latest_comp" },
  heatmap_loi: { kind: "heatmap_loi", mode: "latest_comp" },
} as const;

export type ThumbnailSource = (typeof sources)[keyof typeof sources];
export type Env = Readonly<Record<string, string | undefined>>;

export const maxJpegBytes = 8 * 1024 * 1024;

export function readThumbnailSource(
  camera: CameraId,
  env: Env,
): ThumbnailSource {
  const key = `IPRO_${camera.toUpperCase()}_THUMBNAIL_KIND`;
  const value = env[key]?.trim() || "movcnt";
  if (!Object.hasOwn(sources, value)) {
    throw new ThumbnailError(
      "config",
      `Invalid ${key}; choose movcnt, heatmap_mov or heatmap_loi.`,
    );
  }
  return sources[value as keyof typeof sources];
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function extractThumbnail(
  body: Buffer,
  source: ThumbnailSource,
  contentType: string | null,
  boundary: string | null = null,
) {
  let parsed: ReturnType<typeof parseResponse>;
  try {
    parsed = parseResponse(body, { ...source, contentType, boundary });
  } catch {
    throw new ThumbnailError(
      "invalid_response",
      "Camera Multipart, CSV or JPEG validation failed.",
    );
  }
  if (parsed.status === "no_data")
    return { status: "no_data", noDataCode: parsed.code } as const;
  if (parsed.status !== "data") {
    throw new ThumbnailError(
      "camera_data",
      "Camera reported an error in its image response.",
    );
  }
  if (parsed.images.length !== 1) {
    throw new ThumbnailError(
      "image_count",
      "Expected exactly one JPEG index image.",
    );
  }
  const [image] = parsed.images;
  if (image.contentType?.split(";")[0].trim().toLowerCase() !== "image/jpeg") {
    throw new ThumbnailError(
      "image_type",
      "JPEG part must have Content-Type image/jpeg.",
    );
  }
  if (image.byteLength > maxJpegBytes) {
    throw new ThumbnailError("image_size", "JPEG exceeds the 8 MiB limit.");
  }
  return {
    status: "image",
    image: image.data,
    sha256: sha256(image.data),
    ...(image.period
      ? {
          sourceStartUtc: image.period.startUtc,
          sourceEndUtc: image.period.endUtc,
        }
      : {}),
  } as const;
}

function cameraFailure(response: CameraResponse): ThumbnailError {
  if (response.status === 401 || response.status === 403) {
    return new ThumbnailError(
      "camera_auth",
      `Camera authentication or access failed (HTTP ${response.status}).`,
    );
  }
  if (response.error?.type === "response_too_large") {
    return new ThumbnailError(
      "image_size",
      "Camera response exceeds the transport size limit.",
    );
  }
  if (
    response.status === 429 ||
    (response.status !== null && response.status >= 500)
  ) {
    return new ThumbnailError(
      "camera_upstream",
      `Camera request failed (HTTP ${response.status}).`,
    );
  }
  if (response.error || response.status === null) {
    return new ThumbnailError(
      "camera_network",
      response.error?.message ?? "Camera connection failed.",
    );
  }
  return new ThumbnailError(
    "camera_http",
    `Unexpected camera response (HTTP ${response.status}).`,
  );
}

async function liveSource(
  cameraId: CameraId,
  source: ThumbnailSource,
  env: Env,
  runtime: string,
) {
  const { camera, error } = readCameraConfig(cameraId, env);
  if (!camera) throw new ThumbnailError("config", error);

  let response = await getCameraResponse(camera, source);
  for (
    let attempt = 0;
    attempt < 2 &&
    ([429, 500, 502, 503, 504].includes(response.status ?? 0) ||
      response.error?.type === "timeout");
    attempt++
  ) {
    await wait(250 * 2 ** attempt);
    response = await getCameraResponse(camera, source);
  }

  const retrievedAtUtc = new Date().toISOString();
  let directory: string;
  let saved: Awaited<ReturnType<typeof saveResponse>>;
  try {
    directory = await createRunDirectory(
      join(runtime, "goal3-b"),
      cameraId,
      newRunId(),
    );
    saved = await saveResponse(
      directory,
      camera,
      source,
      response,
      retrievedAtUtc,
    );
  } catch {
    throw new ThumbnailError(
      "capture_storage",
      "Could not save the local camera capture.",
    );
  }
  const rawFile = relative(process.cwd(), saved.bodyPath ?? saved.metadataPath);
  if (response.status !== 200 || !response.body || response.error) {
    throw cameraFailure(response);
  }

  const result = extractThumbnail(response.body, source, response.contentType);
  if (result.status === "image") {
    try {
      await writeFile(join(directory, "thumbnail.jpg"), result.image, {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      throw new ThumbnailError(
        "capture_storage",
        "Could not save the extracted JPEG locally.",
      );
    }
  }
  return { ...result, retrievedAtUtc, rawFile };
}

async function archivedSource(
  camera: CameraId,
  source: ThumbnailSource,
  runtime: string,
  filename: string,
) {
  try {
    const file = resolve(filename);
    const root = ["goal1", "goal3-b"]
      .map((goal) => join(runtime, goal))
      .find((root) => {
        const path = relative(root, file);
        return (
          !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)
        );
      });
    if (!root) throw new Error();
    const capture = capturePath(root, file);
    if (
      capture.cameraId !== camera ||
      capture.stem !== `${source.kind}_${source.mode}`
    )
      throw new Error();
    const sidecar = `${file.slice(0, -4)}.meta.json`;
    const canonical = join(
      await realpath(root),
      camera,
      capture.runId,
      capture.stem,
    );
    if (
      (await realpath(file)) !== `${canonical}.bin` ||
      (await realpath(sidecar)) !== `${canonical}.meta.json`
    )
      throw new Error();
    const { metadata, body } = await readCapture(capture);
    return {
      ...extractThumbnail(
        body,
        source,
        metadata.contentType,
        metadata.boundary,
      ),
      retrievedAtUtc: metadata.acquiredAtUtc,
      rawFile: relative(process.cwd(), file),
    };
  } catch (error) {
    if (error instanceof ThumbnailError) throw error;
    throw new ThumbnailError(
      "source_file",
      "Expected a saved .bin and .meta.json matching the selected camera and CGI source.",
    );
  }
}

export function acquireThumbnail(
  camera: CameraId,
  source: ThumbnailSource,
  env: Env,
  runtime: string,
  sourceFile?: string,
) {
  return sourceFile === undefined
    ? liveSource(camera, source, env, runtime)
    : archivedSource(camera, source, runtime, sourceFile);
}
