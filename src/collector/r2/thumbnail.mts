import { type CameraId, cameraIds } from "../config.mts";
import { ThumbnailError } from "./failure.mts";
import {
  acquireThumbnail,
  type Env,
  readThumbnailSource,
  type ThumbnailSource,
} from "./source.mts";
import {
  type ObjectHead,
  type ThumbnailStore,
  thumbnailCacheControl,
} from "./storage.mts";

const keys: Record<CameraId, string> = {
  food: "cameras/food/thumbnail.jpg",
  island: "cameras/island/thumbnail.jpg",
};

export function thumbnailKey(id: string): string {
  const camera = cameraIds.find((entry) => entry === id);
  if (!camera) throw new ThumbnailError("camera_id", "Select food or island.");
  return keys[camera];
}

type ImageDetails = {
  bytes: number;
  sha256: string;
  retrievedAtUtc: string;
  sourceStartUtc?: string;
  sourceEndUtc?: string;
  rawFile: string;
};

interface ResultContext {
  camera: CameraId;
  key: string;
  source?: ThumbnailSource;
  image?: ImageDetails;
  lastModifiedUtc?: string;
}

export type ThumbnailResult = ResultContext &
  (
    | { status: "uploaded" | "unchanged" }
    | {
        status: "no_data";
        noDataCode: 0 | 1 | 2;
        retrievedAtUtc: string;
        rawFile: string;
      }
    | {
        status: "dry_run";
        plan: "create" | "update" | "unchanged" | "not_checked";
      }
    | {
        status: "failed" | "uncertain";
        error: { code: string; message: string };
      }
  );

function metadataMatches(
  head: ObjectHead | null,
  image: ImageDetails,
): head is ObjectHead {
  return (
    head?.metadata.sha256 === image.sha256 &&
    head.bytes === image.bytes &&
    head.contentType === "image/jpeg"
  );
}

function safeError(error: unknown) {
  return error instanceof ThumbnailError
    ? { code: error.code, message: error.message }
    : {
        code: "unexpected",
        message: "Thumbnail operation failed unexpectedly.",
      };
}

export async function refreshCameraThumbnail(
  camera: CameraId,
  {
    env,
    runtime,
    store,
    dryRun = false,
    sourceFile,
  }: {
    env: Env;
    runtime: string;
    store?: ThumbnailStore;
    dryRun?: boolean;
    sourceFile?: string;
  },
): Promise<ThumbnailResult> {
  const result: ResultContext = { camera, key: thumbnailKey(camera) };
  let putStarted = false;
  let putReturned = false;
  try {
    const source = readThumbnailSource(camera, env);
    result.source = source;
    if (!store && !dryRun)
      throw new ThumbnailError("config", "R2 storage is required for uploads.");
    const acquisition = await acquireThumbnail(
      camera,
      source,
      env,
      runtime,
      sourceFile,
    );
    if (acquisition.status === "no_data") return { ...result, ...acquisition };
    const { image, status: _status, ...details } = acquisition;
    result.image = { ...details, bytes: image.length };

    if (!store) return { ...result, status: "dry_run", plan: "not_checked" };
    const head = await store.head(result.key);
    result.lastModifiedUtc = head?.lastModifiedUtc;
    const same =
      metadataMatches(head, result.image) &&
      (await store.getDigest(result.key, image.length, head.etag)) ===
        details.sha256;
    if (dryRun) {
      return {
        ...result,
        status: "dry_run",
        plan: same ? "unchanged" : head ? "update" : "create",
      };
    }
    if (same) return { ...result, status: "unchanged" };

    if (head && !head.etag) {
      throw new ThumbnailError(
        "r2_verify",
        "R2 HEAD did not supply an ETag for safe replacement.",
      );
    }
    const metadata = {
      "camera-id": camera,
      sha256: details.sha256,
      "retrieved-at-utc": details.retrievedAtUtc,
      "source-kind": source.kind,
      "source-mode": source.mode,
      ...(details.sourceStartUtc && details.sourceEndUtc
        ? {
            "source-start-utc": details.sourceStartUtc,
            "source-end-utc": details.sourceEndUtc,
          }
        : {}),
    };
    putStarted = true;
    const etag = await store.put(
      result.key,
      image,
      metadata,
      head?.etag ? { etag: head.etag } : null,
    );
    putReturned = true;
    const saved = await store.head(result.key);
    if (
      !metadataMatches(saved, result.image) ||
      !saved.etag ||
      saved.cacheControl !== thumbnailCacheControl ||
      (etag && etag !== saved.etag) ||
      Object.entries(metadata).some(
        ([name, value]) => saved.metadata[name] !== value,
      )
    ) {
      throw new ThumbnailError(
        "r2_verify",
        "R2 HEAD could not verify the uploaded JPEG metadata.",
      );
    }
    if (
      (await store.getDigest(result.key, image.length, saved.etag)) !==
      details.sha256
    ) {
      throw new ThumbnailError(
        "r2_verify",
        "R2 GET SHA-256 differs from the uploaded JPEG.",
      );
    }
    return {
      ...result,
      status: "uploaded",
      lastModifiedUtc: saved.lastModifiedUtc,
    };
  } catch (caught) {
    const error = safeError(caught);
    const uncertain =
      putReturned ||
      (putStarted &&
        [
          "r2_network",
          "r2_upstream",
          "r2_rate_limit",
          "r2_conflict",
          "unexpected",
        ].includes(error.code));
    // After a failed verification, the previous HEAD timestamp no longer describes a known current object.
    if (uncertain) delete result.lastModifiedUtc;
    return { ...result, status: uncertain ? "uncertain" : "failed", error };
  }
}
