import { type IncomingMessage, request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { buildCgiUrl, type CgiRequest } from "./cgi.mts";
import type { CameraConfig } from "./config.mts";

export const maxResponseBytes = 16 * 1024 * 1024;

export interface CameraResponse {
  status: number | null;
  contentType: string | null;
  body: Buffer | null;
  bytesReceived: number;
  error?: { type: string; message: string };
}

function requestBody(url: URL, authorization: string, signal: AbortSignal) {
  const request = url.protocol === "https:" ? requestHttps : requestHttp;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "GET",
        headers: {
          Authorization: authorization,
          "Accept-Encoding": "identity",
        },
        ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
        signal,
      },
      resolve,
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

export async function getCameraResponse(
  camera: CameraConfig,
  cgi: CgiRequest,
): Promise<CameraResponse> {
  const url = buildCgiUrl(camera.baseUrl, cgi);
  const token = Buffer.from(`${camera.username}:${camera.password}`).toString(
    "base64",
  );
  const signal = AbortSignal.timeout(camera.timeoutMs);
  const result: CameraResponse = {
    status: null,
    contentType: null,
    body: null,
    bytesReceived: 0,
  };

  try {
    // Node HTTP leaves the response bytes intact and does not follow redirects.
    const response = await requestBody(url, `Basic ${token}`, signal);
    result.status = response.statusCode ?? null;
    result.contentType = response.headers["content-type"] ?? null;

    if (Number(response.headers["content-length"]) > maxResponseBytes) {
      response.destroy();
      return { ...result, error: sizeError };
    }

    const chunks: Buffer[] = [];
    for await (const chunk of response as AsyncIterable<Buffer>) {
      result.bytesReceived += chunk.length;
      if (result.bytesReceived > maxResponseBytes) {
        return { ...result, error: sizeError };
      }
      chunks.push(chunk);
    }
    result.body = Buffer.concat(chunks, result.bytesReceived);
    return result;
  } catch (error) {
    if (signal.aborted) {
      return {
        ...result,
        error: { type: "timeout", message: "Camera request timed out." },
      };
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return {
        ...result,
        error: {
          type: "dns",
          message: "Camera hostname could not be resolved.",
        },
      };
    }
    return {
      ...result,
      error: {
        type: result.status === null ? "connection" : "response_read",
        message:
          result.status === null
            ? "Camera connection failed."
            : "Camera response could not be read completely.",
      },
    };
  }
}

const sizeError = {
  type: "response_too_large",
  message: `Camera response exceeded the ${maxResponseBytes} byte limit.`,
};
