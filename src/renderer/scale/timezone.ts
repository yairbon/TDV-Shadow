/**
 * Display timezone (Phase 10.2).
 *
 * Mandate #5 keeps the DATA layer in UTC epoch milliseconds with no local-time
 * arithmetic, and nothing here changes that. A timezone is a LABEL concern: it shifts the
 * instant at which a day boundary is drawn and the text printed beside it, never a bar's
 * stored time, never an index, never a coordinate.
 *
 * The shift is expressed as "add this many minutes to the UTC timestamp, then format it
 * with the existing UTC formatters". That keeps one formatting path instead of two, and
 * it is exact — including DST, because the offset is asked of `Intl` for the specific
 * instant rather than assumed constant.
 *
 * Offsets are cached per (zone, UTC day). A zone's offset changes at most a couple of
 * times a year, so a per-day cache is both correct and enough to keep `Intl` off the
 * per-frame path — it would otherwise be called once per visible tick, every frame.
 */

/** IANA zone name, or 'UTC'. */
export type TimeZone = string;

const MS_DAY = 86_400_000;

/**
 * `Intl.DateTimeFormat` with `timeZoneName: 'longOffset'` yields e.g. "GMT-04:00".
 * Parsing that is the documented way to get a numeric offset without shipping a tz
 * database; there is no direct API for it.
 */
const OFFSET_PATTERN = /GMT([+-])(\d{2}):(\d{2})/;

const formatters = new Map<string, Intl.DateTimeFormat>();
const cache = new Map<string, number>();

function formatterFor(zone: TimeZone): Intl.DateTimeFormat | null {
  const existing = formatters.get(zone);
  if (existing !== undefined) return existing;
  try {
    const made = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    formatters.set(zone, made);
    return made;
  } catch {
    // An unknown zone must not throw into a frame. Falling back to UTC is the one
    // behaviour that cannot make the chart lie about anything but the label.
    return null;
  }
}

/**
 * Minutes to add to a UTC timestamp to get wall-clock time in `zone` at that instant.
 *
 * Positive east of Greenwich. `UTC` and any unrecognised zone give 0.
 */
export function offsetMinutes(zone: TimeZone, t: number): number {
  if (zone === 'UTC' || zone === '') return 0;
  const day = Math.floor(t / MS_DAY);
  const key = `${zone}:${String(day)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const formatter = formatterFor(zone);
  if (formatter === null) {
    cache.set(key, 0);
    return 0;
  }
  const part = formatter.formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName');
  const match = part === undefined ? null : OFFSET_PATTERN.exec(part.value);
  // "GMT" with no offset is how the exactly-zero case is rendered.
  const minutes =
    match === null ? 0 : (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  cache.set(key, minutes);
  return minutes;
}

/** The timestamp to hand a UTC formatter so it prints wall-clock time in `zone`. */
export function shiftToZone(t: number, zone: TimeZone): number {
  return t + offsetMinutes(zone, t) * 60_000;
}

/** Zones offered in the settings sheet. A short, honest list beats a 400-entry menu. */
export const TIME_ZONES: readonly TimeZone[] = Object.freeze([
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Jerusalem',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
]);
