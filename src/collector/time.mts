export function utcMinute(date: string, time: string): string {
  if (
    !/^\d{8}$/.test(date) ||
    !/^\d{4}$/.test(time) ||
    date.startsWith("0000")
  ) {
    throw new Error("Invalid UTC date or time.");
  }
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${time.slice(0, 2)}:${time.slice(2)}:00.000Z`;
  const timestamp = Date.parse(iso);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== iso
  ) {
    throw new Error("Invalid UTC date or time.");
  }
  return iso;
}

export function utcToJst(utc: string): string {
  return new Date(Date.parse(utc) + 9 * 3_600_000)
    .toISOString()
    .replace(/Z$/, "+09:00");
}
