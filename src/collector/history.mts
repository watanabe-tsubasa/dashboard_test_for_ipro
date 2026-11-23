import { utcMinute } from "./time.mts";

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

export interface HistoryWindow {
  startUtc: string;
  endUtc: string;
}

export function historyInstant(input: string): number {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00(?:\.000)?)?(Z|\+09:00)$/.exec(
      input,
    );
  if (!match) {
    throw new Error(
      "Use a date and minute with an explicit Z or +09:00 suffix.",
    );
  }
  const [, year, month, date, hour, minute, zone] = match;
  const utc = Date.parse(utcMinute(year + month + date, hour + minute));
  return utc - (zone === "+09:00" ? 9 * hourMs : 0);
}

export function isWithinHistoryWindow(
  period: HistoryWindow,
  window: HistoryWindow,
): boolean {
  return (
    period.startUtc >= window.startUtc &&
    period.startUtc < window.endUtc &&
    period.endUtc <= window.endUtc
  );
}

export function historyQuery(from: string, to: string) {
  const start = historyInstant(from);
  const end = historyInstant(to);
  if (end <= start) {
    throw new Error("The history end must be later than its start.");
  }

  // The camera starts at UTC midnight and ends days * 24 + hour hours later.
  // Request the smallest compatible range that covers the requested minutes.
  const firstMidnight = Math.floor(start / dayMs) * dayMs;
  const lastHour = Math.max(
    firstMidnight + dayMs,
    Math.ceil(end / hourMs) * hourMs,
  );
  const days = Math.floor((lastHour - firstMidnight) / dayMs);
  if (days > 6) {
    throw new Error("The camera history window requires days between 1 and 6.");
  }
  const startUtc = new Date(start).toISOString();
  const endUtc = new Date(end).toISOString();
  if (!/^(?!0000)\d{4}-/.test(startUtc) || !/^(?!0000)\d{4}-/.test(endUtc)) {
    throw new Error(
      "The UTC history year must have four digits and be greater than zero.",
    );
  }
  const [year, month, date] = startUtc.slice(0, 10).split("-");
  const hour = new Date(lastHour).getUTCHours();
  return {
    window: { startUtc, endUtc },
    parameters: { year, month: Number(month), date: Number(date), days, hour },
  };
}
