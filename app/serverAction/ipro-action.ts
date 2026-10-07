"use server";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function fetchIproRange() {
  const cameraUrl = process.env.CAMERA_URL;
  const user = process.env.CAMERA_USER;
  const password = process.env.CAMERA_PASS;

  const payload = "{{appMethod:csv},{kind:movcnt_info},{mode:range}}";
  const base64 = Buffer.from(payload).toString("base64");

  const { stdout } = await execFileAsync("curl", [
    "--digest",
    "-u",
    `${user}:${password}`,
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

  return stdout;
}