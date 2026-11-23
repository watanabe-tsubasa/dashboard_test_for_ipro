import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CgiRequest } from "./cgi.mts";
import type { CameraConfig, CameraId } from "./config.mts";
import type { CameraResponse } from "./iproClient.mts";

type Outcome = {
  result: "success" | "no_data" | "http_error" | "network_error" | "unknown";
  error?: { type: string; message: string };
};

function multipartBoundary(contentType: string | null): string | null {
  if (!contentType || !/^multipart\//i.test(contentType)) {
    return null;
  }
  const value = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return value?.[1] ?? value?.[2] ?? null;
}

function hasMultipartCsv(body: Buffer, boundary: string): boolean {
  const start = body.subarray(0, 2).equals(Buffer.from("\r\n")) ? 2 : 0;
  const marker = Buffer.from(`--${boundary}\r\n`);
  if (!body.subarray(start, start + marker.length).equals(marker)) {
    return false;
  }

  // Inspect only the first part's headers. The full payload is saved unchanged.
  const headersStart = start + marker.length;
  const prefix = body.subarray(headersStart, headersStart + 4096);
  const separator = prefix.indexOf("\r\n\r\n");
  const payloadStart = headersStart + separator + 4;
  const emptyPart = Buffer.from(`\r\n--${boundary}`);
  if (
    separator === -1 ||
    payloadStart >= body.length ||
    body
      .subarray(payloadStart, payloadStart + emptyPart.length)
      .equals(emptyPart)
  ) {
    return false;
  }
  const headers = prefix.subarray(0, separator).toString("latin1");
  return /^Content-Disposition:[^\r\n]*\bfilename="[^"\r\n]+\.csv"/im.test(
    headers,
  );
}

function classify(
  request: CgiRequest,
  { status, body, error }: CameraResponse,
  boundary: string | null,
): Outcome {
  if (status !== null && (status < 200 || status >= 300)) {
    const httpError =
      status === 401 || status === 403
        ? {
            type: "authentication",
            message: "Camera rejected authentication or access.",
          }
        : status === 404
          ? { type: "not_found", message: "Camera CGI endpoint was not found." }
          : status >= 500
            ? {
                type: "server_error",
                message: "Camera returned a server error.",
              }
            : {
                type: "http_status",
                message: "Camera returned an unexpected HTTP status.",
              };
    return { result: "http_error", error: error ?? httpError };
  }
  if (error) {
    return { result: "network_error", error };
  }

  if (status === 200 && body?.length) {
    if (
      request.mode !== "range" &&
      boundary &&
      hasMultipartCsv(body, boundary)
    ) {
      return { result: "success" };
    }

    const text = body.length <= 512 ? body.toString("utf8").trim() : "";
    const noData = /^No Data(?:\(([1-3])\))?\.$/.exec(text);
    if (noData) {
      const code = Number(noData[1] ?? 0);
      const messages = [
        "No CSV data exists.",
        "The camera feature may be off or the line may be unconfigured.",
        "The camera is preparing the CSV data.",
        "The camera reported an unspecified error.",
      ];
      return {
        result: code === 3 ? "unknown" : "no_data",
        error: {
          type: code ? `no_data_${code}` : "no_data",
          message: messages[code],
        },
      };
    }

    const matchesRange =
      /^DataFrom=\d{10}(?:\d{2})?\(UTC\)\r?\nDataUntil=\d{10}(?:\d{2})?\(UTC\)$/.test(
        text,
      );
    if (request.mode === "range" && matchesRange) {
      return { result: "success" };
    }
  }

  return {
    result: "unknown",
    error: {
      type: "unexpected_body",
      message: "Camera response format was not recognized.",
    },
  };
}

export function newRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  return `${timestamp}-${randomUUID()}`;
}

export async function createRunDirectory(
  outputRoot: string,
  id: CameraId,
  runId: string,
): Promise<string> {
  const cameraDirectory = join(outputRoot, id);
  await mkdir(cameraDirectory, { recursive: true, mode: 0o700 });
  const runDirectory = join(cameraDirectory, runId);
  await mkdir(runDirectory, { mode: 0o700 });
  return runDirectory;
}

export async function saveResponse(
  directory: string,
  camera: CameraConfig,
  request: CgiRequest,
  response: CameraResponse,
  fetchedAt: string,
) {
  const base = join(directory, `${request.kind}_${request.mode}`);
  const bodyPath = response.body === null ? null : `${base}.bin`;
  const metadataPath = `${base}.meta.json`;
  const boundary = multipartBoundary(response.contentType);
  const outcome = classify(request, response, boundary);
  const token = Buffer.from(`${camera.username}:${camera.password}`).toString(
    "base64",
  );
  const safeHeader = (value: string | null) =>
    value &&
    [camera.username, camera.password, token].some((secret) =>
      value.includes(secret),
    )
      ? null
      : value;
  const metadata = {
    cameraId: camera.id,
    cameraName: camera.name,
    fetchedAt,
    ...request,
    httpStatus: response.status,
    contentType: safeHeader(response.contentType),
    byteLength: response.body?.length ?? null,
    bytesReceived: response.bytesReceived,
    boundary: safeHeader(boundary),
    ...outcome,
  };

  if (bodyPath && response.body) {
    await writeNewFile(bodyPath, response.body);
  }

  try {
    await writeNewFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  } catch (error) {
    if (bodyPath) {
      await rm(bodyPath, { force: true }).catch(() => {});
    }
    throw error;
  }

  return { ...metadata, bodyPath, metadataPath };
}

async function writeNewFile(path: string, contents: string | Buffer) {
  const file = await open(path, "wx", 0o600);
  try {
    try {
      await file.writeFile(contents);
    } finally {
      await file.close();
    }
  } catch (error) {
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}
