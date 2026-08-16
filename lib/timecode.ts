/**
 * timecode.ts — port of app/timecode.py.
 *
 * The one rule that matters here: formatting TRUNCATES, never rounds. A
 * displayed stamp must never seek ahead of its own frame, so 4.999s reads as
 * 00:00:04.99 and not 00:00:05.00.
 */

/** Port of format_tc — "HH:MM:SS.cc" at decimals=2, "HH:MM:SS" at decimals=0. */
export function formatTc(seconds: number, decimals = 2): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  let sec = s % 60;

  // Truncate rather than round, matching math.floor(s * 100) / 100.
  const factor = 10 ** decimals;
  sec = Math.floor(sec * factor) / factor;

  const width = decimals > 0 ? decimals + 3 : 2;
  const secStr = sec.toFixed(decimals).padStart(width, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${secStr}`;
}

/**
 * Port of parse_tc — deliberately lenient, matching the desktop field's
 * behaviour: accepts HH:MM:SS.mmm, MM:SS, SS.s, bare seconds, and comma
 * decimals. Anything unparseable returns 0 rather than throwing, so a
 * half-typed timecode never blows up the editor.
 */
export function parseTc(text: string): number {
  const raw = (text ?? "").trim().replace(",", ".");
  if (!raw) return 0;
  const parts = raw.split(":");
  try {
    if (parts.length === 3) {
      const [h, m, s] = parts;
      return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
    }
    if (parts.length === 2) {
      const [m, s] = parts;
      return (Number(m) || 0) * 60 + (Number(s) || 0);
    }
    return Number(parts[0]) || 0;
  } catch {
    return 0;
  }
}

/**
 * Port of the library delegate's format_short — "M:SS", or "H:MM:SS" past an
 * hour. Note the leading unit is deliberately not zero-padded.
 */
export function formatShort(seconds: number): string {
  const total = Math.floor(Math.max(0, seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Port of database.human_size. */
export function humanSize(bytes: number): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return i === 0 ? `${value} ${units[i]}` : `${value.toFixed(1)} ${units[i]}`;
}
