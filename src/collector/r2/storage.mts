import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { R2Config } from "./config.mts";
import { ThumbnailError } from "./failure.mts";

export const thumbnailCacheControl = "private, no-cache";

export interface ObjectHead {
  bytes?: number;
  contentType?: string;
  cacheControl?: string;
  etag?: string;
  lastModifiedUtc?: string;
  metadata: Record<string, string>;
}

export interface ThumbnailStore {
  head(key: string): Promise<ObjectHead | null>;
  put(
    key: string,
    image: Buffer,
    metadata: Record<string, string>,
    match: { etag: string } | null,
  ): Promise<string | undefined>;
  getDigest(key: string, bytes: number, etag?: string): Promise<string>;
}

const transientStatus = new Set([429, 500, 502, 503, 504]);
const transientNames = new Set([
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "RequestTimeout",
  "TimeoutError",
]);
const transientCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
]);

function s3Failure(error: unknown, operation: "HEAD" | "PUT" | "GET") {
  if (error instanceof ThumbnailError) return { error, retry: false };
  const source = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  const status = source?.$metadata?.httpStatusCode;
  const name = source?.name ?? "";
  const code = source?.code ?? "";
  if (status === 401 || status === 403 || name === "AccessDenied") {
    return {
      error: new ThumbnailError(
        "r2_permissions",
        `R2 ${operation} access denied.`,
      ),
      retry: false,
    };
  }
  if (name === "NoSuchBucket" || (status === 404 && operation === "PUT")) {
    return {
      error: new ThumbnailError(
        "r2_bucket_missing",
        "R2 bucket was not found.",
      ),
      retry: false,
    };
  }
  if (status === 404 || name === "NotFound" || name === "NoSuchKey") {
    return {
      error: new ThumbnailError(
        "r2_not_found",
        `R2 ${operation} object was not found.`,
      ),
      retry: false,
    };
  }
  if (status === 409 || status === 412) {
    return {
      error: new ThumbnailError(
        "r2_conflict",
        "R2 object changed during the operation. Recheck before retrying.",
      ),
      retry: false,
    };
  }
  const retry =
    transientStatus.has(status ?? 0) ||
    transientNames.has(name) ||
    transientCodes.has(code);
  if (status === 429 || name === "SlowDown" || name.startsWith("Throttling")) {
    return {
      error: new ThumbnailError(
        "r2_rate_limit",
        `R2 ${operation} was rate limited.`,
      ),
      retry,
    };
  }
  if (status !== undefined) {
    return {
      error: new ThumbnailError(
        status >= 500 ? "r2_upstream" : "r2_rejected",
        `R2 ${operation} failed (HTTP ${status}).`,
      ),
      retry,
    };
  }
  return {
    error: new ThumbnailError(
      "r2_network",
      `R2 ${operation} connection or stream failed.`,
    ),
    retry,
  };
}

async function run<T>(
  operation: "HEAD" | "PUT" | "GET",
  send: (signal: AbortSignal) => Promise<T>,
  delay: (milliseconds: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.timeout(20_000);
    try {
      return await send(signal);
    } catch (error) {
      const failure = s3Failure(
        signal.aborted ? signal.reason : error,
        operation,
      );
      if (!failure.retry || attempt === 2) throw failure.error;
      await delay(250 * 2 ** attempt);
    }
  }
}

export function createR2Store(
  { bucket, endpoint, credentials }: R2Config,
  client = new S3Client({
    endpoint,
    credentials,
    region: "auto",
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  }),
  delay: (milliseconds: number) => Promise<void> = wait,
) {
  function getObject<T>(
    key: string,
    max: number,
    expected: number | undefined,
    etag: string | undefined,
    consume: (chunk: Buffer) => void,
    done: (lastModifiedUtc?: string) => T,
    reset: () => void,
  ) {
    return run(
      "GET",
      async (abortSignal) => {
        reset();
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: etag }),
          { abortSignal },
        );
        const body = response.Body;
        if (!(body instanceof Readable)) {
          throw new ThumbnailError(
            "r2_verify",
            "R2 GET did not return a readable JPEG body.",
          );
        }
        const length = response.ContentLength;
        if (
          !length ||
          length < 4 ||
          length > max ||
          (expected !== undefined && length !== expected) ||
          (expected === undefined && response.ContentType !== "image/jpeg")
        ) {
          body.destroy();
          throw new ThumbnailError(
            "r2_verify",
            "R2 GET returned unexpected JPEG headers.",
          );
        }
        const abort = () => body.destroy();
        if (abortSignal.aborted) {
          body.destroy();
          throw abortSignal.reason;
        }
        abortSignal.addEventListener("abort", abort, { once: true });
        try {
          let received = 0;
          for await (const chunk of body as AsyncIterable<Buffer>) {
            received += chunk.length;
            if (received > length)
              throw new ThumbnailError(
                "r2_verify",
                "R2 GET exceeded its reported length.",
              );
            consume(chunk);
          }
          if (received !== length)
            throw new ThumbnailError("r2_verify", "R2 GET body ended early.");
          return done(response.LastModified?.toISOString());
        } finally {
          abortSignal.removeEventListener("abort", abort);
          body.destroy();
        }
      },
      delay,
    );
  }

  function readDigest(key: string, bytes: number, etag?: string) {
    let hash = createHash("sha256");
    return getObject(
      key,
      bytes,
      bytes,
      etag,
      (chunk) => hash.update(chunk),
      () => hash.digest("hex"),
      () => {
        hash = createHash("sha256");
      },
    );
  }

  return {
    async head(key: string) {
      try {
        const response = await run(
          "HEAD",
          (abortSignal) =>
            client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
              abortSignal,
            }),
          delay,
        );
        return {
          bytes: response.ContentLength,
          contentType: response.ContentType,
          cacheControl: response.CacheControl,
          etag: response.ETag,
          lastModifiedUtc: response.LastModified?.toISOString(),
          metadata: response.Metadata ?? {},
        };
      } catch (error) {
        if (error instanceof ThumbnailError && error.code === "r2_not_found")
          return null;
        throw error;
      }
    },
    async put(
      key: string,
      image: Buffer,
      metadata: Record<string, string>,
      match: { etag: string } | null,
    ) {
      const response = await run(
        "PUT",
        (abortSignal) =>
          client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: image,
              ContentType: "image/jpeg",
              ContentLength: image.length,
              CacheControl: thumbnailCacheControl,
              ContentMD5: createHash("md5").update(image).digest("base64"),
              Metadata: metadata,
              ...(match ? { IfMatch: match.etag } : { IfNoneMatch: "*" }),
            }),
            { abortSignal },
          ),
        delay,
      );
      return response.ETag;
    },
    getDigest(key: string, bytes: number, etag?: string) {
      return readDigest(key, bytes, etag);
    },
    readImage(key: string, max: number) {
      let chunks: Buffer[] = [];
      return getObject(
        key,
        max,
        undefined,
        undefined,
        (chunk) => chunks.push(chunk),
        (lastModifiedUtc) => {
          const data = Buffer.concat(chunks);
          if (
            data.readUInt16BE(0) !== 0xffd8 ||
            data.readUInt16BE(data.length - 2) !== 0xffd9
          ) {
            throw new ThumbnailError(
              "r2_verify",
              "R2 object does not contain a JPEG image.",
            );
          }
          return { data, lastModifiedUtc };
        },
        () => {
          chunks = [];
        },
      );
    },
    close: () => client.destroy(),
  };
}
