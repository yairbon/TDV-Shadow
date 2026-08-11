/**
 * FROZEN CONTRACT — chart-type transforms (Phase 5, workstream C).
 *
 * A chart type is a pure function from the base OHLCV series to a *derived* series plus
 * a draw style. Two families exist and the difference is load-bearing:
 *
 *   1:1 types   (candles, hollow, bars, line, area, baseline, step, columns, Heikin Ashi)
 *               emit exactly one output bar per input bar. Index space is unchanged, so
 *               the time axis, crosshair snapping and drawing anchors keep working.
 *
 *   resampling  (Renko, Kagi, Point & Figure, Line Break, Range) emit a DIFFERENT number
 *   types       of bars, driven by price movement rather than time. Index space is their
 *               own; `sourceIndex` maps each output bar back to the input bar that closed
 *               it, and the time axis must label from that mapping — otherwise timestamps
 *               drift silently.
 *
 * Everything here is immutable and allocation-conscious: transforms run on the visible
 * range only, memoised by (revision, type, params), never per frame.
 */

import type { Bar, TimeMs } from '../data/types.js';

export const CHART_TYPES = [
  'candles',
  'hollow-candles',
  'bars',
  'line',
  'area',
  'baseline',
  'step-line',
  'columns',
  'heikin-ashi',
  'renko',
  'kagi',
  'point-and-figure',
  'line-break',
  'range',
] as const;

export type ChartType = (typeof CHART_TYPES)[number];

/** How the series layer should paint a derived series. */
export type DrawStyle =
  | 'candle' // filled bodies + wicks
  | 'hollow' // outlined bodies when close >= open
  | 'bar' // OHLC tick bars
  | 'polyline' // single stroked line through `c`
  | 'area' // polyline + gradient fill to the plot floor
  | 'baseline' // area split above/below a reference price
  | 'step' // orthogonal polyline
  | 'column' // one filled column per bar from the floor
  | 'brick'; // Renko / Line Break / P&F blocks

/** A bar in a derived series. Superset of `Bar`; never mutated. */
export interface DerivedBar extends Bar {
  /**
   * Index into the ORIGINAL bars array that produced this bar. For 1:1 types this is
   * the identity. For resampling types it is the bar whose price closed the brick —
   * the time axis and crosshair read timestamps through this, never by position.
   */
  readonly sourceIndex: number;
  /** True when the type draws direction independently of open/close (Renko, Kagi). */
  readonly rising: boolean;
}

export interface DerivedSeries {
  readonly type: ChartType;
  readonly style: DrawStyle;
  readonly bars: readonly DerivedBar[];
  /** False for resampling types — consumers must map through `sourceIndex`. */
  readonly preservesIndexSpace: boolean;
  /** Reference price for `baseline`; null for every other style. */
  readonly baseline: number | null;
}

/** Per-type tuning. Absent fields take the transform's documented default. */
export interface ChartTypeParams {
  /** Renko / Range brick size in price units. Null = ATR-derived (period 14). */
  readonly brickSize?: number | null;
  /** Kagi reversal amount, price units or percent when `kagiPercent` is true. */
  readonly reversal?: number;
  readonly kagiPercent?: boolean;
  /** Point & Figure box size and reversal count (classic default 3). */
  readonly boxSize?: number | null;
  readonly reversalBoxes?: number;
  /** Line Break look-back (classic default 3). */
  readonly lineBreaks?: number;
  /** Baseline reference; defaults to the first visible close. */
  readonly baselinePrice?: number;
}

export interface ChartTypeTransform {
  readonly type: ChartType;
  readonly style: DrawStyle;
  readonly preservesIndexSpace: boolean;
  /** Pure. Input is ascending by `t`; output is ascending by `sourceIndex`. */
  transform(bars: readonly Bar[], params: ChartTypeParams): DerivedSeries;
}

/** Timestamp of a derived bar, resolved through the source mapping. */
export function timeOf(derived: DerivedBar, source: readonly Bar[]): TimeMs {
  // Bounds check rather than an `undefined` test: `noUncheckedIndexedAccess` is off
  // (see tsconfig.json), so the index type is `Bar` and a null test would be dead per
  // types while still being live at runtime for a stale sourceIndex.
  const i = derived.sourceIndex;
  if (i < 0 || i >= source.length) return derived.t;
  return source[i].t;
}
