"use server";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function fetchIproRange() {
  const cameraUrl = process.env.CAMERA_URL;
  const user = process.env.CAMERA_USER;
  const password = process.env.CAMERA_PASS;
  if (!cameraUrl || !user || !password) {
    throw new Error("Digest test camera configuration is incomplete.");
  }
  const base = URL.canParse(cameraUrl) ? new URL(cameraUrl) : null;
  if (
    !base ||
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    user.includes(":") ||
    /\p{Cc}/u.test(user + password)
  ) {
    throw new Error("Digest test camera configuration is invalid.");
  }

  const payload = "{{appMethod:csv},{kind:movcnt_info},{mode:range}}";
  const base64 = Buffer.from(payload).toString("base64");

  const request = execFileAsync("curl", [
    "--digest",
    "--config",
    "-",
    "-G",
    "--data-urlencode",
    "methodName=sendDataToAdamApplication",
    "--data-urlencode",
    "appName=iVmdApp",
    "--data-urlencode",
    "s_appDataType=0",
    "--data-urlencode",
    `s_appData=${base64}`,
    `${cameraUrl}/cgi-bin/adam.cgi`,
  ]);
  // Pass credentials over stdin so curl's arguments and command errors omit them.
  const escapedCredentials = `${user}:${password}`.replace(/["\\]/g, "\\$&");
  request.child.stdin?.on("error", () => {});
  request.child.stdin?.end(`user = "${escapedCredentials}"\n`);

  const { stdout } = await request.catch(() => {
    throw new Error("Digest test camera request failed.");
  });

  return stdout;
}
