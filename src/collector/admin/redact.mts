import { cameraIds } from "../config.mts";

export function createRedactor(
  env: Readonly<Record<string, string | undefined>>,
) {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (
      value &&
      /^(?:IPRO_.*_(?:BASE_URL|USER|PASSWORD)|CAMERA_(?:URL|USER|PASS)|CLOUDFLARE_.*(?:TOKEN|ACCESS_KEY(?:_ID)?|ACCOUNT_ID|DATABASE_ID))$/.test(
        key,
      )
    ) {
      secrets.add(value);
      if (URL.canParse(value) && /^https?:/i.test(value))
        secrets.add(new URL(value).hostname);
    }
  }
  for (const camera of cameraIds) {
    const prefix = `IPRO_${camera.toUpperCase()}_`;
    const user = env[`${prefix}USER`];
    const password = env[`${prefix}PASSWORD`];
    if (user && password)
      secrets.add(Buffer.from(`${user}:${password}`).toString("base64"));
  }
  const values = [...secrets].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let safe = text
      .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9+/_=.-]+/gi, "[redacted]")
      .replace(/https?:\/\/[^\s]+/gi, "[redacted]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted]");
    for (const value of values) safe = safe.replaceAll(value, "[redacted]");
    return safe.replace(/[\r\n\p{Cc}]+/gu, " ");
  };
}
