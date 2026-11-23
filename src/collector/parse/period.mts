import { utcMinute } from "../time.mts";

export interface Period {
  startUtc: string;
  endUtc: string;
  intervalMinutes: number;
  cameraTimezone: string;
  summertime: "IN" | "OUT";
}

export function parsePeriod(columns: string[]): Period {
  if (columns.length !== 7) {
    throw new Error("CSV period row must have seven columns.");
  }
  const [
    startDate,
    startTime,
    endDate,
    endTime,
    interval,
    cameraTimezone,
    summertime,
  ] = columns;
  const startUtc = utcMinute(startDate, startTime);
  const endUtc = utcMinute(endDate, endTime);
  if (endUtc < startUtc) {
    throw new Error("CSV period ends before it starts.");
  }

  const hours = Number(interval.slice(0, 2));
  const minutes = Number(interval.slice(3));
  const intervalMinutes = hours * 60 + minutes;
  if (
    !/^\d{2}:[0-5]\d$/.test(interval) ||
    intervalMinutes < 1 ||
    intervalMinutes > 1440
  ) {
    throw new Error("Invalid CSV recording interval.");
  }
  if (!/^[+-](?:(?:0\d|1[01]):[0-5]\d|12:00)$/.test(cameraTimezone)) {
    throw new Error("Invalid CSV camera time zone.");
  }
  if (summertime !== "IN" && summertime !== "OUT") {
    throw new Error("Invalid CSV summertime flag.");
  }
  return { startUtc, endUtc, intervalMinutes, cameraTimezone, summertime };
}
