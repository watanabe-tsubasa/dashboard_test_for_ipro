export const cameraIds = ["food", "island"] as const;
export type CameraId = (typeof cameraIds)[number];

export interface CameraConfig {
  id: CameraId;
  name: string;
  baseUrl: URL;
  username: string;
  password: string;
  timeoutMs: number;
}

type ConfigResult =
  | { camera: CameraConfig; error?: never }
  | { camera?: never; error: string };

export function readCameraConfig(
  id: CameraId,
  env: Readonly<Record<string, string | undefined>>,
): ConfigResult {
  const prefix = `IPRO_${id.toUpperCase()}_`;
  const name = env[`${prefix}NAME`]?.trim();
  const address = env[`${prefix}BASE_URL`]?.trim();
  const username = env[`${prefix}USER`];
  const password = env[`${prefix}PASSWORD`];
  const missing = [
    ["NAME", name],
    ["BASE_URL", address],
    ["USER", username?.trim()],
    ["PASSWORD", password],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => `${prefix}${key}`);
  if (!name || !address || !username?.trim() || !password) {
    return { error: `Missing settings: ${missing.join(", ")}` };
  }

  const baseUrl = URL.canParse(address) ? new URL(address) : null;
  if (
    !baseUrl ||
    !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(address) ||
    !["http:", "https:"].includes(baseUrl.protocol)
  ) {
    return {
      error: `${prefix}BASE_URL must be an HTTP(S) origin without credentials.`,
    };
  }
  if (username.includes(":") || /\p{Cc}/u.test(username + password)) {
    return {
      error: `Invalid Basic credentials in ${prefix}USER or ${prefix}PASSWORD.`,
    };
  }

  const timeout = env.IPRO_TIMEOUT_MS ?? "10000";
  const timeoutMs = Number(timeout);
  if (!/^\d+$/.test(timeout) || timeoutMs < 1 || timeoutMs > 300_000) {
    return { error: "IPRO_TIMEOUT_MS must be an integer from 1 to 300000." };
  }

  return { camera: { id, name, baseUrl, username, password, timeoutMs } };
}
