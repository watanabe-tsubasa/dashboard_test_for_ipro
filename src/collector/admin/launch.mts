import { spawn } from "node:child_process";
import { resolve } from "node:path";

export async function launchJob(id: string): Promise<void> {
  const cwd = process.cwd();
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      resolve(cwd, "src/collector/admin/runner.mts"),
      id,
    ],
    { cwd, detached: true, shell: false, stdio: "ignore" },
  );
  await new Promise<void>((success, failure) => {
    child.once("spawn", success);
    child.once("error", failure);
  });
  child.unref();
}
