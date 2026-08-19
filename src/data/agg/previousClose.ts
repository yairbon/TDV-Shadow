/**
 * The previous session's close — the level TradingView keeps a dashed line on.
 *
 * Derived from the bars already on the chart rather than fetched, so it is available for
 * any instrument at any timeframe without spending a request, and it agrees with what is
 * drawn by construction. A quote's own `previousClose` is the vendor's answer for the
 * CURRENT session; this one answers "previous relative to the last bar in view", which is
 * what a line drawn across those bars has to mean.
 *
 * No `Date` and no timezone math, per this directory's rules: the caller passes the
 * display zone's offset in milliseconds and the bucketing is plain integer arithmetic.
 *
 * ## The assumption, stated
 *
 * A session does not straddle midnight in the display zone. That holds for US equities —
 * the case this app is built around — and does not hold for FX or futures, where a session
 * opens the previous evening. For those the answer here is the close of the previous
 * CALENDAR day, which is a defensible reading of the same words but not the venue's own.
 *
 * A single offset is used across the range rather than resolved per bar. A DST transition
 * shifts the wall clock by an hour, which cannot move a session-open bar into a different
 * calendar day for any venue whose session starts well after midnight.
 */

import { TIMEFRAME_MS, type Bar, type Timeframe } from '../types.js';

/** Taken from the timeframe table rather than restated, so there is one definition of a day. */
const MS_DAY = TIMEFRAME_MS['1d'];

/**
 * The close of the session before the last bar's, or `null` when the bars do not contain
 * one.
 *
 * Null rather than a guess in three cases: fewer than two bars, a series that never leaves
 * one calendar day, and a non-finite offset. Each would otherwise produce a line the reader
 * could not distinguish from a real level.
 */
export function previousSessionClose(
  bars: readonly Bar[],
  timeframe: Timeframe,
  zoneOffsetMs = 0,
): number | null {
  if (bars.length < 2 || !Number.isFinite(zoneOffsetMs)) return null;

  // At a daily timeframe or coarser every bar IS a session, so the previous one is simply
  // the bar before. Bucketing by day would compare a bar to itself.
  if (TIMEFRAME_MS[timeframe] >= MS_DAY) return bars[bars.length - 2].c;

  const dayOf = (bar: Bar): number => Math.floor((bar.t + zoneOffsetMs) / MS_DAY);
  const today = dayOf(bars[bars.length - 1]);
  for (let i = bars.length - 2; i >= 0; i--) {
    // The first bar walking back that belongs to an earlier day is that day's LAST bar,
    // which is exactly the previous session's close.
    if (dayOf(bars[i]) !== today) return bars[i].c;
  }
  return null;
}
