/**
 * Comparison overlay — a second instrument projected onto the PRIMARY series' index space.
 *
 * Two instruments are never drawn against the same price axis: AAPL near 300 and SPY near
 * 770 on one linear scale flattens whichever has the smaller range into a straight line.
 * A comparison is a RELATIVE reading, so both sides are re-based to 0% at the left edge of
 * the view and drawn against a percent scale.
 *
 * The hard part is alignment, not drawing.
 *
 * The primary owns the index space (RENDER_ALGORITHMS §5: index space is uniform, sessions
 * and gaps consume no width), so a value must exist for every PRIMARY index. The secondary
 * has its own calendar — different holidays, a later listing date, an earlier delisting,
 * possibly a different bar count entirely. Zipping the two arrays by index is the obvious
 * implementation and it is wrong: one extra holiday in the secondary shifts every later
 * value by a bar, and the overlay reads as a plausible curve that is off by a day and
 * getting worse.
 *
 * So alignment is by TIME (mandate #5: `t` is integer UTC epoch ms of the bar OPEN), with
 * three rules:
 *
 *   FORWARD-FILL, NEVER INTERPOLATE. For each primary bar take the secondary's most recent
 *   close at or before that time. When the secondary did not trade that day its last close
 *   is still the honest answer — that is what the instrument was worth. Interpolating
 *   between the closes either side invents a price that never traded and then draws it.
 *
 *   NO VALUE BEFORE THE FIRST BAR. A secondary that listed halfway through the primary's
 *   history has no price before it listed. Back-filling its first close paints a flat line
 *   at 0% across years the instrument did not exist. Emit NaN; the renderer breaks the line
 *   there (the established convention — see `strokePlot` in `annotationsLayer.ts`).
 *
 *   NO VALUE AFTER THE LAST BAR. Forward-fill is bounded by the last observation. Carrying
 *   a delisted instrument's final close to the right edge draws a flat line that looks like
 *   a live quote. Past the secondary's last bar there is no observation, so: NaN.
 *
 * One pass, not a binary search per bar: both arrays are ascending, so a single walk with a
 * trailing cursor is O(n + m) and touches each secondary bar at most once.
 */

import type { Bar } from '../data/types.js';

export interface ComparisonSeries {
  /** One value per PRIMARY bar index. NaN where the secondary has no data. */
  readonly values: Float64Array;
  /** Percent change from the base, per primary index. NaN where absent. */
  readonly percent: Float64Array;
  /** The close the percent series is re-based on. NaN when there is no overlap. */
  readonly base: number;
  /** First primary index that has a value; -1 when the overlap is empty. */
  readonly from: number;
  /** Last primary index that has a value; -1 when the overlap is empty. */
  readonly to: number;
}

/**
 * Aligns `secondary` onto `primary`'s index space by time and re-bases on the first
 * overlapping close.
 *
 * Complexity O(n + m) in time and O(n) in space, where n = `primary.length`. Neither input
 * is read more than once and neither is mutated (mandate #4).
 */
export function alignByTime(primary: readonly Bar[], secondary: readonly Bar[]): ComparisonSeries {
  const n = primary.length;
  const m = secondary.length;
  const values = new Float64Array(n).fill(Number.NaN);

  let from = -1;
  let to = -1;

  if (n > 0 && m > 0) {
    const lastTime = secondary[m - 1].t;
    // Cursor into the secondary: the most recent bar at or before the current primary time.
    // -1 means "the primary is still earlier than the secondary's first bar".
    let j = -1;
    for (let i = 0; i < n; i++) {
      const t = primary[i].t;
      // Ascending in both arrays, so this advances a total of m times across the whole
      // loop — the walk is linear, not a search per bar.
      while (j + 1 < m && secondary[j + 1].t <= t) j++;
      // Past the last observation. Primary times ascend, so nothing later can be covered.
      if (t > lastTime) break;
      if (j < 0) continue;
      const close = secondary[j].c;
      if (!Number.isFinite(close)) continue;
      values[i] = close;
      if (from === -1) from = i;
      to = i;
    }
  }

  return withBase(values, from, to, from);
}

/**
 * Re-bases an aligned series onto the close at `baseIndex` (the left edge of the view).
 *
 * The `values` array is shared with `series` rather than copied: nothing here mutates it,
 * and every pan re-bases, so copying 100k doubles per frame would be pure waste.
 */
export function rebase(series: ComparisonSeries, baseIndex: number): ComparisonSeries {
  return withBase(series.values, series.from, series.to, baseIndex);
}

function withBase(
  values: Float64Array,
  from: number,
  to: number,
  baseIndex: number,
): ComparisonSeries {
  const base = resolveBase(values, baseIndex);
  const percent = new Float64Array(values.length).fill(Number.NaN);

  // `base <= 0` has no meaningful percent change — dividing by it yields either a sign flip
  // or an infinity, both of which draw a line that means nothing. NaN is the honest answer.
  if (from >= 0 && base > 0) {
    for (let i = from; i <= to; i++) {
      const v = values[i];
      if (Number.isNaN(v)) continue;
      percent[i] = (v / base - 1) * 100;
    }
  }

  return Object.freeze({ values, percent, base, from, to });
}

/**
 * The close to re-base on.
 *
 * `baseIndex` is the view's left edge, which routinely lands where the secondary has no
 * value — on its leading NaNs, or past its last bar. Searching forward first keeps the
 * re-basing anchored as close to the left edge as the data allows; only when nothing lies
 * at or after it does the search fall back to the left, so that scrolling past a delisted
 * instrument still shows its history rather than blanking the whole overlay. NaN comes back
 * only when there is genuinely no overlap at all.
 */
function resolveBase(values: Float64Array, baseIndex: number): number {
  const n = values.length;
  if (n === 0) return Number.NaN;

  const wanted = Number.isFinite(baseIndex) ? Math.trunc(baseIndex) : 0;
  const start = wanted < 0 ? 0 : wanted > n - 1 ? n - 1 : wanted;

  for (let i = start; i < n; i++) {
    const v = values[i];
    if (!Number.isNaN(v)) return v;
  }
  for (let i = start - 1; i >= 0; i--) {
    const v = values[i];
    if (!Number.isNaN(v)) return v;
  }
  return Number.NaN;
}
