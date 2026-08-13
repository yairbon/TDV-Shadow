/**
 * Indicator on indicator — an SMA of an RSI, a Bollinger band around an OBV.
 *
 * The mechanism is TradingView's: the source indicator's output is fed to the second
 * indicator AS the price series. Nothing in `IndicatorDefinition` changes, so all twenty
 * indicators can be stacked on all twenty without a single one of them learning about it —
 * the alternative, threading an optional source array through every `compute`, would have
 * touched every definition and left each free to ignore it.
 *
 * What a synthesised bar is, and what it is not:
 *
 * - `o`, `h`, `l`, `c` are all the source value. A derived series has no intrabar range,
 *   and inventing one would put a fake wick under an ATR. Every price `source` setting
 *   (`close`, `hl2`, `ohlc4`, …) therefore resolves to the same number, which is the
 *   correct answer rather than a limitation.
 * - `t` is carried through unchanged. It is the bar's OPEN time in UTC ms (mandate #5) and
 *   the second indicator is aligned to exactly the bars the first was.
 * - `v` is carried through too, so a volume-weighted indicator over a derived series
 *   weights by the volume that actually traded. An OBV of an RSI is a strange thing to
 *   ask for, but it is not an ill-defined one.
 *
 * Warm-up composes. The source's leading NaNs arrive as NaN bars, and every kernel here
 * already treats NaN as "no value yet", so a 14-period RSI under a 9-period SMA forms at
 * bar 22 rather than bar 8. That is the honest answer, and it is asserted in the spec.
 */

import type { Bar } from '../data/types.js';
import { asPrice, asTimeMs } from '../data/types.js';
import type { IndicatorResult } from './types.js';

/** Names one plot of one live indicator: the handle it belongs to, and which plot. */
export interface IndicatorSource {
  readonly handleId: string;
  readonly plotKey: string;
}

/**
 * Parses `"<handleId>:<plotKey>"`, or null when the string is not one.
 *
 * A single string because that is what a `<select>` option value and a persisted param
 * can both hold without a schema change — `params.source` already carries `'close'` and
 * friends, and this extends the same field rather than adding a parallel one that could
 * disagree with it.
 */
export function parseIndicatorSource(raw: string | undefined): IndicatorSource | null {
  if (raw === undefined) return null;
  const at = raw.indexOf(':');
  if (at <= 0 || at === raw.length - 1) return null;
  return { handleId: raw.slice(0, at), plotKey: raw.slice(at + 1) };
}

/** Formats an `IndicatorSource` back into the single string `params.source` holds. */
export function formatIndicatorSource(source: IndicatorSource): string {
  return `${source.handleId}:${source.plotKey}`;
}

/**
 * Projects one plot of an indicator result back into a bar series.
 *
 * Returns null when the plot does not exist or its length does not match the bars — a
 * derived indicator computed against a mismatched array would silently read values from
 * the wrong bars, which looks like a plausible curve and is off by however far the two
 * disagree.
 *
 * `from` clips the leading warm-up; see `deriveOver` for why that is not optional.
 */
export function seriesAsBars(
  bars: readonly Bar[],
  result: IndicatorResult,
  plotKey: string,
  from = 0,
): readonly Bar[] | null {
  const values = result.values[plotKey] as Float64Array | undefined;
  if (values === undefined || values.length !== bars.length) return null;

  const out: Bar[] = [];
  for (let i = from; i < bars.length; i++) {
    const value = asPrice(values[i]);
    out.push(
      Object.freeze({
        t: asTimeMs(bars[i].t),
        o: value,
        h: value,
        l: value,
        c: value,
        v: bars[i].v,
      }),
    );
  }
  return out;
}

/** Index of the first value that is not NaN, or -1 when there is none. */
function firstFormed(values: Float64Array): number {
  for (let i = 0; i < values.length; i++) if (!Number.isNaN(values[i])) return i;
  return -1;
}

/**
 * Computes an indicator over another indicator's plot.
 *
 * The warm-up is CLIPPED before computing and padded back afterwards, rather than being
 * handed to the second indicator as NaN. This is not tidiness: the kernels carry running
 * sums, and one NaN entering a running sum keeps it NaN for the rest of the array — a
 * 9-period SMA over a 14-period RSI came out empty for the whole series, not merely late.
 * Clipping means each stage sees a clean array starting at its source's first real value,
 * so warm-up composes by addition and the arrays stay bar-aligned.
 *
 * Interior NaN would still poison a running sum. No indicator here produces one — they
 * warm up at the front and, where they lead the price (Ichimoku's spans), stop at the
 * back — so it is left as it is rather than papered over with an interpolation that would
 * invent data.
 *
 * Returns null when the source plot is unusable, so the caller can fall back to price
 * rather than draw an empty overlay that looks like a bug in the indicator.
 */
export function deriveOver(
  bars: readonly Bar[],
  source: IndicatorResult,
  plotKey: string,
  compute: (over: readonly Bar[]) => IndicatorResult,
): IndicatorResult | null {
  const values = source.values[plotKey] as Float64Array | undefined;
  if (values === undefined || values.length !== bars.length) return null;

  const start = firstFormed(values);
  if (start < 0) return null;

  const projected = seriesAsBars(bars, source, plotKey, start);
  if (projected === null) return null;

  const inner = compute(projected);

  // Re-expand every plot to the full bar count, NaN-padded on the left by exactly what
  // was clipped — the renderer indexes these arrays by bar index and nothing else.
  const expanded: Record<string, Float64Array> = {};
  for (const plot of inner.plots) {
    const short = inner.values[plot.key] as Float64Array | undefined;
    const full = new Float64Array(bars.length).fill(Number.NaN);
    if (short !== undefined) full.set(short.subarray(0, bars.length - start), start);
    expanded[plot.key] = full;
  }

  return { ...inner, values: expanded, warmup: inner.warmup + start };
}
