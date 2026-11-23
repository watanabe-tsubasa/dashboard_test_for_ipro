import { type HistoryWindow, historyInstant } from "../history.mts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

export interface Bounds {
  from?: number;
  to?: number;
}

export function readBounds(from?: string, to?: string): Bounds {
  const lower = from === undefined ? undefined : historyInstant(from);
  const upper = to === undefined ? undefined : historyInstant(to);
  if (lower !== undefined && upper !== undefined && lower >= upper) {
    throw new Error("The requested end must be later than its start.");
  }
  return { from: lower, to: upper };
}

export function retainedWindow(
  range: { dataFromUtc: string; dataUntilUtc: string },
  bounds: Bounds,
  now: number,
): HistoryWindow | undefined {
  // The camera can report the start of the last saved hour as DataUntil.
  const start = Math.max(
    Date.parse(range.dataFromUtc),
    bounds.from ?? -Infinity,
  );
  const end = Math.min(
    Date.parse(range.dataUntilUtc) + hour,
    bounds.to ?? Infinity,
    Math.floor(now / minute) * minute,
  );
  if (start < end) {
    return {
      startUtc: new Date(start).toISOString(),
      endUtc: new Date(end).toISOString(),
    };
  }
}

function mergeCoverage(coverage: readonly HistoryWindow[]) {
  const merged: HistoryWindow[] = [];
  for (const period of [...coverage].sort((left, right) =>
    left.startUtc.localeCompare(right.startUtc),
  )) {
    const last = merged.at(-1);
    if (last && period.startUtc <= last.endUtc) {
      if (period.endUtc > last.endUtc) last.endUtc = period.endUtc;
    } else {
      merged.push({ ...period });
    }
  }
  return merged;
}

export function dailyWindows(
  window: HistoryWindow,
  completed?: readonly HistoryWindow[],
): HistoryWindow[] {
  const coverage = mergeCoverage(completed ?? []);
  const overlapStart = Date.parse(coverage.at(-1)?.endUtc ?? "") - day;
  const end = Date.parse(window.endUtc);
  const days: HistoryWindow[] = [];
  let start = Date.parse(window.startUtc);
  let at = 0;
  while (start < end) {
    const next = Math.min((Math.floor(start / day) + 1) * day, end);
    const portion = {
      startUtc: new Date(start).toISOString(),
      endUtc: new Date(next).toISOString(),
    };
    while (coverage[at] && coverage[at].endUtc <= portion.startUtc) at++;
    const available = coverage[at];
    if (
      !available ||
      available.startUtc > portion.startUtc ||
      available.endUtc < portion.endUtc ||
      next > overlapStart
    ) {
      days.push(portion);
    }
    start = next;
  }
  return days;
}

export function windowForRequest(
  portion: HistoryWindow,
  overall: HistoryWindow,
): HistoryWindow {
  // Leave room for a camera interval that starts before midnight and ends after it.
  const end = Math.min(
    Date.parse(portion.endUtc) + hour,
    Date.parse(overall.endUtc),
  );
  return { startUtc: portion.startUtc, endUtc: new Date(end).toISOString() };
}
