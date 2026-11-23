import { utcMinute } from "../time.mts";
import { type CsvMeasurement, type NormalizedKind, parseCsv } from "./csv.mts";
import { multipartBoundary, parseMultipart } from "./multipart.mts";
import type { Period } from "./period.mts";

export const normalizedKinds = {
  movcnt: "linecross",
  movcnt_info: "linecross",
  heatmap_mov_info: "heatmap_mov",
  heatmap_loi_info: "heatmap_loi",
  heatmap_mov: "heatmap_mov",
  heatmap_loi: "heatmap_loi",
} as const satisfies Record<string, NormalizedKind>;

export interface PartMetadata {
  partNumber: number;
  partFilename: string | null;
  contentType: string | null;
  byteLength: number;
}

export type ParsedRecord = CsvMeasurement & { part: PartMetadata };

export type ParsedResponse =
  | {
      status: "data";
      records: ParsedRecord[];
      images: Array<
        PartMetadata & {
          data: Buffer;
          period: Period | null;
          csvPartNumber: number | null;
        }
      >;
    }
  | {
      status: "range";
      dataFromUtc: string;
      dataUntilUtc: string;
      precision: "hour" | "minute";
    }
  | { status: "no_data"; code: 0 | 1 | 2 }
  | { status: "camera_error"; code: 3 };

function filenameKey(filename: string | null): string | undefined {
  return /_(latest(?:_comp)?|\d{12}_\d{12})\.(?:csv|jpe?g)$/i
    .exec(filename ?? "")?.[1]
    .toLowerCase();
}

export function parseResponse(
  body: Buffer,
  context: {
    kind: keyof typeof normalizedKinds;
    mode: string;
    contentType: string | null;
    boundary: string | null;
  },
): ParsedResponse {
  const isShortAscii =
    body.length <= 512 &&
    body.every(
      (byte) =>
        byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126),
    );
  const text = isShortAscii ? body.toString("ascii").trim() : "";
  const noData = /^No Data(?:\(([1-3])\))?\.$/.exec(text);
  if (noData) {
    switch (noData[1]) {
      case "1":
        return { status: "no_data", code: 1 };
      case "2":
        return { status: "no_data", code: 2 };
      case "3":
        return { status: "camera_error", code: 3 };
      default:
        return { status: "no_data", code: 0 };
    }
  }

  if (context.mode === "range") {
    const range =
      /^DataFrom=(\d{10}(?:\d{2})?)\(UTC\)\r?\nDataUntil=(\d{10}(?:\d{2})?)\(UTC\)$/.exec(
        text,
      );
    if (!range || range[1].length !== range[2].length) {
      throw new Error("Invalid range response.");
    }
    const dataFromUtc = utcMinute(
      range[1].slice(0, 8),
      range[1].slice(8).padEnd(4, "0"),
    );
    const dataUntilUtc = utcMinute(
      range[2].slice(0, 8),
      range[2].slice(8).padEnd(4, "0"),
    );
    if (dataUntilUtc < dataFromUtc) {
      throw new Error("Camera range ends before it starts.");
    }
    return {
      status: "range",
      dataFromUtc,
      dataUntilUtc,
      precision: range[1].length === 10 ? "hour" : "minute",
    };
  }

  const boundary = multipartBoundary(context.contentType) ?? context.boundary;
  if (!boundary) {
    throw new Error("Missing multipart boundary in capture metadata.");
  }
  const parts = parseMultipart(body, boundary).map((part, index) => ({
    type: part.type,
    data: part.data,
    metadata: {
      partNumber: index + 1,
      partFilename: part.filename,
      contentType: part.contentType,
      byteLength: part.data.length,
    },
  }));
  const records = parts
    .filter((part) => part.type === "csv")
    .map((part) => {
      try {
        return {
          ...parseCsv(part.data, normalizedKinds[context.kind]),
          part: part.metadata,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid CSV.";
        throw new Error(`Part ${part.metadata.partNumber}: ${message}`);
      }
    });
  if (!records.length) {
    throw new Error("No CSV part found in multipart response.");
  }

  const jpegParts = parts.filter((part) => part.type === "jpeg");
  const images = jpegParts.map((part) => {
    const key = filenameKey(part.metadata.partFilename);
    const matches = key
      ? records.filter(
          (record) => filenameKey(record.part.partFilename) === key,
        )
      : [];
    const matched =
      matches.length === 1 &&
      jpegParts.filter(
        (jpeg) => filenameKey(jpeg.metadata.partFilename) === key,
      ).length === 1
        ? matches[0]
        : null;
    return {
      ...part.metadata,
      data: part.data,
      period: matched?.period ?? null,
      csvPartNumber: matched?.part.partNumber ?? null,
    };
  });
  return { status: "data", records, images };
}
