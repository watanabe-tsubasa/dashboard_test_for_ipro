export interface MultipartPart {
  type: "csv" | "jpeg";
  filename: string | null;
  contentType: string | null;
  data: Buffer;
}

export function multipartBoundary(contentType: string | null): string | null {
  if (!contentType || !/^\s*multipart\//i.test(contentType)) {
    return null;
  }
  const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))\s*(?:;|$)/i.exec(
    contentType,
  );
  return match?.[1] ?? match?.[2] ?? null;
}

function boundaryAt(body: Buffer, marker: Buffer, offset: number) {
  if (!body.subarray(offset, offset + marker.length).equals(marker)) {
    return null;
  }
  let end = offset + marker.length;
  const closed = body[end] === 45 && body[end + 1] === 45;
  if (closed) {
    end += 2;
  }
  while (body[end] === 32 || body[end] === 9) {
    end++;
  }
  if (body[end] === 13 && body[end + 1] === 10) {
    end++;
  }
  if (body[end] === 10) {
    end++;
  } else if (end !== body.length) {
    return null;
  }
  // Some i-PRO responses terminate with a bare delimiter at EOF.
  return { offset, end, closed: closed || end === body.length };
}

function nextBoundary(body: Buffer, marker: Buffer, start: number) {
  let offset = body.indexOf(marker, start);
  while (offset !== -1) {
    if (offset === 0 || body[offset - 1] === 10) {
      const match = boundaryAt(body, marker, offset);
      if (match) {
        return match;
      }
    }
    offset = body.indexOf(marker, offset + marker.length);
  }
  return null;
}

function partHeaders(body: Buffer, start: number) {
  const headers = new Map<string, string>();
  const limit = start + 8192;
  let previous: string | undefined;
  while (start < limit) {
    const newline = body.indexOf(10, start);
    if (newline < 0 || newline >= limit) {
      break;
    }
    const end = body[newline - 1] === 13 ? newline - 1 : newline;
    const line = body.toString("latin1", start, end);
    start = newline + 1;
    if (line === "") {
      return { headers, start };
    }
    if (previous && /^[ \t]/.test(line)) {
      headers.set(previous, `${headers.get(previous)} ${line.trim()}`);
      continue;
    }
    const match = /^([\w-]+):[ \t]*(.*)$/.exec(line);
    if (!match || headers.has(match[1].toLowerCase())) {
      break;
    }
    previous = match[1].toLowerCase();
    headers.set(previous, match[2].trim());
  }
  throw new Error("Invalid or incomplete multipart headers.");
}

function makePart(
  headers: Map<string, string>,
  data: Buffer,
  partNumber: number,
): MultipartPart {
  const disposition = headers.get("content-disposition") ?? "";
  const match = /;\s*filename\s*=\s*(?:"([^"]*)"|([^;"\s]+))\s*(?:;|$)/i.exec(
    disposition,
  );
  const filename = match?.[1] ?? match?.[2] ?? null;
  if (
    (/;\s*filename\s*=/i.test(disposition) && !filename) ||
    (filename &&
      (/[/\\:\p{Cc}]/u.test(filename) || filename === "." || filename === ".."))
  ) {
    throw new Error(
      `Unsafe or invalid filename in multipart part ${partNumber}.`,
    );
  }

  const contentType = headers.get("content-type") ?? null;
  const mediaType = contentType?.split(";")[0].trim().toLowerCase();
  if (
    mediaType === "text/csv" ||
    (/\.csv$/i.test(filename ?? "") &&
      (mediaType === "text/plain" || !mediaType))
  ) {
    return { type: "csv", filename, contentType, data };
  }
  if (
    mediaType === "image/jpeg" ||
    (!mediaType && /\.jpe?g$/i.test(filename ?? ""))
  ) {
    if (
      data.length < 4 ||
      data.readUInt16BE(0) !== 0xffd8 ||
      data.readUInt16BE(data.length - 2) !== 0xffd9
    ) {
      throw new Error(
        `Invalid or incomplete JPEG in multipart part ${partNumber}.`,
      );
    }
    return { type: "jpeg", filename, contentType, data };
  }
  throw new Error(`Unsupported content in multipart part ${partNumber}.`);
}

export function parseMultipart(
  body: Buffer,
  boundary: string,
): MultipartPart[] {
  if (
    !/^[A-Za-z0-9'()+_,./:=? -]{1,70}$/.test(boundary) ||
    boundary.endsWith(" ")
  ) {
    throw new Error("Invalid multipart boundary.");
  }
  const marker = Buffer.from(`--${boundary}`);
  let delimiter = nextBoundary(body, marker, 0);
  if (!delimiter || delimiter.closed) {
    throw new Error("Multipart opening boundary was not found.");
  }

  const parts: MultipartPart[] = [];
  while (!delimiter.closed) {
    const { headers, start } = partHeaders(body, delimiter.end);
    const length = headers.get("content-length");
    let end: number;
    let csvSharesNewline = false;
    if (length !== undefined) {
      const count = Number(length);
      if (
        !/^\d+$/.test(length) ||
        !Number.isSafeInteger(count) ||
        count > body.length - start
      ) {
        throw new Error(
          `Invalid Content-Length in multipart part ${parts.length + 1}.`,
        );
      }
      end = start + count;
      const framing =
        body[end] === 13 && body[end + 1] === 10 ? 2 : body[end] === 10 ? 1 : 0;
      delimiter = framing ? boundaryAt(body, marker, end + framing) : null;
      // Image-bearing i-PRO captures can count the separator CRLF in the CSV part.
      if (
        !delimiter &&
        count >= 2 &&
        body[end - 2] === 13 &&
        body[end - 1] === 10
      ) {
        delimiter = boundaryAt(body, marker, end);
        csvSharesNewline = delimiter !== null;
      }
      if (!delimiter) {
        throw new Error(
          `Content-Length or boundary mismatch in multipart part ${parts.length + 1}.`,
        );
      }
    } else {
      delimiter = nextBoundary(body, marker, start);
      if (!delimiter) {
        throw new Error("Multipart closing boundary was not found.");
      }
      end = delimiter.offset - (body[delimiter.offset - 2] === 13 ? 2 : 1);
      if (end < start) {
        throw new Error("Multipart part is missing its framing newline.");
      }
    }
    const part = makePart(headers, body.subarray(start, end), parts.length + 1);
    if (csvSharesNewline && part.type !== "csv") {
      throw new Error(
        `Content-Length or boundary mismatch in multipart part ${parts.length + 1}.`,
      );
    }
    parts.push(part);
  }
  return parts;
}
