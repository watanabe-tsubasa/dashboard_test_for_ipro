import { ThumbnailError } from "./failure.mts";
import type { Env } from "./source.mts";

export function readR2Config(env: Env, optional = false) {
  const {
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_R2_BUCKET: bucket,
    CLOUDFLARE_R2_ACCESS_KEY_ID: accessKeyId,
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: secretAccessKey,
    CLOUDFLARE_R2_ENDPOINT: configuredEndpoint,
  } = env;
  if (
    optional &&
    !bucket &&
    !accessKeyId &&
    !secretAccessKey &&
    !configuredEndpoint
  )
    return undefined;
  if (
    !account ||
    !/^[a-f0-9]{32}$/i.test(account) ||
    !bucket ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    !accessKeyId ||
    !/^[a-zA-Z0-9_-]+$/.test(accessKeyId) ||
    !secretAccessKey ||
    !/^[a-zA-Z0-9_+/=-]+$/.test(secretAccessKey)
  ) {
    throw new ThumbnailError(
      "config",
      "Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_BUCKET, CLOUDFLARE_R2_ACCESS_KEY_ID and CLOUDFLARE_R2_SECRET_ACCESS_KEY.",
    );
  }
  const endpoint =
    configuredEndpoint ||
    `https://${account.toLowerCase()}.r2.cloudflarestorage.com`;
  const host =
    /^https:\/\/([a-f0-9]{32})(?:\.[a-z0-9-]+)?\.r2\.cloudflarestorage\.com\/?$/i.exec(
      endpoint,
    );
  if (host?.[1].toLowerCase() !== account.toLowerCase()) {
    throw new ThumbnailError(
      "config",
      "CLOUDFLARE_R2_ENDPOINT must be the HTTPS R2 endpoint for the configured account.",
    );
  }
  return { endpoint, bucket, credentials: { accessKeyId, secretAccessKey } };
}

export type R2Config = NonNullable<ReturnType<typeof readR2Config>>;
