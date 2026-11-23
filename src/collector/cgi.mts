import { type HistoryWindow, historyQuery } from "./history.mts";

const allowedModes = {
  movcnt: ["latest"],
  movcnt_info: ["range", "latest"],
  heatmap_mov_info: ["range", "latest_comp"],
  heatmap_loi_info: ["range", "latest_comp"],
  heatmap_mov: ["latest_comp"],
  heatmap_loi: ["latest_comp"],
} as const;

type CurrentRequest = {
  [Kind in keyof typeof allowedModes]: {
    kind: Kind;
    mode: (typeof allowedModes)[Kind][number];
  };
}[keyof typeof allowedModes];

type HistoryKind = Exclude<keyof typeof allowedModes, "movcnt">;

export type CgiRequest =
  | CurrentRequest
  | {
      kind: HistoryKind;
      mode: "multi";
      window: HistoryWindow;
    };

export function buildCgiUrl(baseUrl: URL, request: CgiRequest): URL {
  const { kind, mode } = request;
  if (
    !Object.hasOwn(allowedModes, kind) ||
    (mode === "multi"
      ? !request.window || (kind as string) === "movcnt"
      : !(allowedModes[kind] as readonly string[]).includes(mode))
  ) {
    throw new Error("Unsupported CGI kind/mode combination.");
  }

  const url = new URL("/cgi-bin/adam.cgi", baseUrl);
  const options = [`{appMethod:csv}`, `{kind:${kind}}`, `{mode:${mode}}`];
  if (request.mode === "multi") {
    const { parameters } = historyQuery(
      request.window.startUtc,
      request.window.endUtc,
    );
    options.push(
      ...Object.entries(parameters).map(([key, value]) => `{${key}:${value}}`),
    );
  }
  const payload = `{${options.join(",")}}`;
  url.search = new URLSearchParams({
    methodName: "sendDataToAdamApplication",
    appName: "iVmdApp",
    s_appDataType: "0",
    s_appData: Buffer.from(payload).toString("base64"),
  }).toString();
  return url;
}

export function cgiRequests(
  command: "probe" | "fetch",
  includeImages: boolean,
  window?: HistoryWindow,
): CgiRequest[] {
  if (command === "probe") {
    return [
      { kind: "movcnt_info", mode: "range" },
      { kind: "heatmap_mov_info", mode: "range" },
      { kind: "heatmap_loi_info", mode: "range" },
    ];
  }

  const requests: Exclude<CurrentRequest, { kind: "movcnt" }>[] = [
    { kind: "movcnt_info", mode: "latest" },
    { kind: "heatmap_mov_info", mode: "latest_comp" },
    { kind: "heatmap_loi_info", mode: "latest_comp" },
  ];
  if (includeImages) {
    requests.push(
      { kind: "heatmap_mov", mode: "latest_comp" },
      { kind: "heatmap_loi", mode: "latest_comp" },
    );
  }
  return window
    ? requests.map(({ kind }) => ({ kind, mode: "multi", window }))
    : requests;
}
