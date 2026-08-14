/**
 * Exchange-local wall-clock time → UTC epoch milliseconds.
 *
 * Providers return intraday timestamps in the exchange's own local time, naive: Twelve
 * Data sends `"2026-08-13 15:30:00"` with `exchange_timezone: "America/New_York"` beside
 * it. Mandate #5 wants integer UTC ms at the bar open, so the conversion happens here, at
 * the ingest boundary, exactly once.
 *
 * This is the most dangerous arithmetic in the data path, because getting it wrong is
 * invisible: every intraday bar shifts by an hour for part of the year and the chart still
 * looks like a chart. Hence the DST cases below are pinned by tests against `Intl` rather
 * than reasoned about.
 *
 * ## Why two passes
 *
 * The UTC offset depends on the instant, and the instant is what we are solving for. So:
 * read the wall clock as if it were UTC, ask the zone for its offset at that guess, and
 * subtract. The guess is wrong by at most the offset itself, which only matters within an
 * hour or two of a transition — so the second pass re-asks at the corrected instant and
 * takes that answer. Two passes is not a heuristic; a third could only differ if a zone
 * changed offset twice inside one offset's width, which no zone does.
 *
 * ## The two days a year that are not a bijection
 *
 * - **Spring forward.** 02:30 on 2026-03-08 in New York never happens: 01:59 is followed
 *   by 03:00. Such a time resolves FORWARD, to 03:30 local, rather than to null. The
 *   direction is forced: the naive arithmetic lands it an hour before the transition, so
 *   an uncorrected 02:30 would sort before 01:59 and the store would reject the later
 *   bar. A gap timestamp is a provider bug either way, but one that keeps the series
 *   ascending is recoverable and visible.
 * - **Fall back.** 01:30 on 2026-11-01 in New York happens twice. The FIRST (still-DST)
 *   occurrence wins. This is not a coin toss: bars must stay strictly ascending in `t`,
 *   and taking the earlier instant keeps a morning's bars monotonic through the repeat.
 *
 * Both are documented behaviour with tests, not accidents.
 */

import { asTimeMs, type TimeMs } from '../data/types.js';
import { offsetMinutes, type TimeZone } from '../renderer/scale/timezone.js';

/** `YYYY-MM-DD` optionally followed by `HH:MM` or `HH:MM:SS`, space- or `T`-separated. */
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * A capture group as `string | undefined`.
 *
 * Indexing a match types as `string` here (`noUncheckedIndexedAccess` is off), but an
 * OPTIONAL group really is undefined when it did not participate — a date with no
 * time-of-day. `.at()` carries that honestly, where `match[4]` would have the compiler
 * insisting a real runtime case cannot happen.
 */
const group = (match: RegExpExecArray, index: number): string | undefined => match.at(index);

/** A group's numeric value, or `fallback` when the group did not participate. */
const groupNumber = (match: RegExpExecArray, index: number, fallback: number): number => {
  const raw = group(match, index);
  return raw === undefined ? fallback : Number(raw);
};

/** A parsed wall clock, as the UTC instant with those same digits. */
function wallAsUtc(wall: string): number | null {
  const match = WALL_CLOCK.exec(wall.trim());
  if (match === null) return null;

  const year = groupNumber(match, 1, 0);
  const month = groupNumber(match, 2, 0);
  const day = groupNumber(match, 3, 0);
  const hour = groupNumber(match, 4, 0);
  const minute = groupNumber(match, 5, 0);
  const second = groupNumber(match, 6, 0);

  // Reject impossible field values rather than letting Date.UTC roll them over: month 13
  // silently becoming January of the next year is the kind of "success" that hides a
  // provider format change for months.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(asUtc) ? asUtc : null;
}

interface Resolved {
  /** The UTC instant, after any gap correction. */
  readonly t: number;
  /** True when the requested wall clock names no instant (spring-forward gap). */
  readonly nonexistent: boolean;
}

function resolve(wall: string, zone: TimeZone): Resolved | null {
  const asUtc = wallAsUtc(wall);
  if (asUtc === null) return null;

  // Pass one: the offset in force near the guess. Pass two: the offset in force at the
  // instant that offset implies. They differ only around a transition, and the second is
  // the one that actually contains the wall clock we were given.
  const firstGuess = asUtc - offsetMinutes(zone, asUtc) * 60_000;
  const settled = asUtc - offsetMinutes(zone, firstGuess) * 60_000;

  /*
   * Does `settled` read back as the digits we were handed?
   *
   * Everywhere except a spring-forward gap, yes. Inside one it cannot, because those
   * digits name no instant — and the arithmetic lands an hour BEFORE the transition
   * rather than after it. That direction matters: 01:59 resolves to 06:59Z and an
   * uncorrected 02:30 resolves to 06:30Z, so a series containing both would go backwards
   * and the store would reject the later bar. Shifting by the width of the jump puts the
   * gap time after the transition, where it keeps the series ascending.
   */
  const roundTrip = settled + offsetMinutes(zone, settled) * 60_000;
  const nonexistent = roundTrip !== asUtc;
  return { t: nonexistent ? settled + (asUtc - roundTrip) : settled, nonexistent };
}

/**
 * Parses a naive wall-clock string in `zone` to UTC epoch ms.
 *
 * Returns null only when the string is not a wall clock at all — never for a real time
 * that happens to fall on a transition. A date with no time-of-day is midnight local,
 * which is what a daily bar's open means on an exchange calendar.
 */
export function zonedTimeToUtc(wall: string, zone: TimeZone): TimeMs | null {
  const resolved = resolve(wall, zone);
  return resolved === null ? null : asTimeMs(resolved.t);
}

/**
 * True when `wall` does not exist in `zone` — the spring-forward gap.
 *
 * Offered because "this timestamp is impossible" is worth counting at the boundary even
 * though `zonedTimeToUtc` resolves it: a provider suddenly emitting gap times means its
 * timezone handling changed, and a silent hour shift is exactly what this module exists
 * to prevent.
 */
export function isNonexistentLocalTime(wall: string, zone: TimeZone): boolean {
  return resolve(wall, zone)?.nonexistent ?? false;
}
