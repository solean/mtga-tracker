const compactDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "numeric",
  day: "numeric",
  year: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function parseTimestamp(ts: string): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function formatDateTime(ts: string): string {
  if (!ts) return "-";
  const d = parseTimestamp(ts);
  if (!d) return ts;
  return d.toLocaleString();
}

export function formatCompactDateTime(ts: string): string {
  if (!ts) return "-";
  const d = parseTimestamp(ts);
  if (!d) return ts;

  const parts = compactDateTimeFormatter.formatToParts(d);
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const year = parts.find((part) => part.type === "year")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value;

  if (!month || !day || !year || !hour || !minute || !dayPeriod) {
    return compactDateTimeFormatter.format(d).replace(", ", " ").replace(/ (\S+)$/, "\u00A0$1");
  }

  return `${month}/${day}/${year} ${hour}:${minute}\u00A0${dayPeriod}`;
}

export function formatDuration(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "-";
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m ${sec}s`;
}

export function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
