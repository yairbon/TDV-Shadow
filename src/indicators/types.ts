/**
 * FROZEN CONTRACT — technical indicators (Phase 5, workstream D).
 *
 * An indicator is a pure function from bars to one or more plots, plus a declaration of
 * WHERE it renders: on the price plot (overlay) or in its own stacked pane with its own
 * value scale. That declaration is what lets layout allocate panes without knowing any
 * indicator's internals.
 *
 * Warm-up is explicit, not implicit: a value that does not exist yet is `NaN`, and the
 * renderer breaks the polyline there rather than drawing a line to zero. An indicator
 * that silently emits 0 for its first N bars draws a cliff that looks like real data.
 */

import type { Bar } from '../data/types.js';

export type IndicatorId =
  | 'sma'
  | 'ema'
  | 'wma'
  | 'vwap'
  | 'bollinger'
  | 'macd'
  | 'rsi'
  | 'stochastic'
  | 'atr'
  | 'volume'
  | 'volume-profile'
  | 'obv'
  | 'cci'
  | 'williams-r'
  | 'donchian'
  | 'keltner'
  | 'adx'
  | 'supertrend'
  | 'psar'
  | 'ichimoku';

/** Where an indicator draws. */
export type IndicatorPlacement = 'overlay' | 'pane';

export type PlotStyle =
  | 'line'
  | 'histogram'
  | 'band'
  | 'fill'
  | 'horizontal-profile'
  /** Discrete markers, one per bar, with no line between them (Parabolic SAR). */
  | 'dots';

export interface PlotSpec {
  readonly key: string;
  readonly label: string;
  readonly style: PlotStyle;
  /** Theme token name, resolved by the renderer — indicators never hard-code colour. */
  readonly colorToken: string;
  /** For 'band'/'fill': the plot key this one pairs with. */
  readonly pairedWith?: string;
}

/**
 * Column-oriented output: one Float64Array per plot, aligned 1:1 with the input bars.
 * Columnar rather than an array of objects so the renderer can walk it without
 * allocating per bar (SKILL.md performance budget).
 */
export interface IndicatorResult {
  readonly id: IndicatorId;
  readonly placement: IndicatorPlacement;
  readonly plots: readonly PlotSpec[];
  /** Keyed by `PlotSpec.key`. `NaN` marks warm-up — the renderer must break the line. */
  readonly values: Readonly<Record<string, Float64Array>>;
  /** Fixed scale bounds for a pane (RSI 0..100); null means autoscale. */
  readonly scaleBounds: readonly [number, number] | null;
  /** Reference lines drawn in the pane (RSI 30/70, MACD zero). */
  readonly guides: readonly number[];
  /** Bars consumed before the first real value. */
  readonly warmup: number;
}

/** Volume Profile is horizontal: values are per PRICE BUCKET, not per bar. */
export interface VolumeProfileResult extends IndicatorResult {
  readonly buckets: readonly { readonly price: number; readonly volume: number }[];
  /** Price of the highest-volume bucket. */
  readonly pointOfControl: number;
  /** Bounds containing `valueAreaPercent` of traded volume. */
  readonly valueAreaHigh: number;
  readonly valueAreaLow: number;
}

export interface IndicatorParams {
  readonly period?: number;
  readonly fastPeriod?: number;
  readonly slowPeriod?: number;
  readonly signalPeriod?: number;
  readonly stdDev?: number;
  /** Keltner / Supertrend: the ATR length, kept separate from the basis `period`. */
  readonly atrPeriod?: number;
  /** Keltner / Supertrend: how many ATRs the band or stop sits away from the basis. */
  readonly multiplier?: number;
  /** Parabolic SAR: acceleration increment and its cap. */
  readonly step?: number;
  readonly maxStep?: number;
  /** Ichimoku: the three window lengths. The cloud displacement follows `kijunPeriod`. */
  readonly tenkanPeriod?: number;
  readonly kijunPeriod?: number;
  readonly senkouBPeriod?: number;
  /**
   * Which series the indicator reads.
   *
   * A price field, or `"<handleId>:<plotKey>"` naming a plot of another indicator already
   * on the chart — an SMA of an RSI. The two live in ONE field rather than two because a
   * second field could disagree with this one, and there would be no principled answer to
   * which wins. `sourceValue` treats anything it does not recognise as `close`, which is
   * what makes the widening safe for the indicators themselves: by the time they see a
   * derived series it has already been projected into bars whose OHLC are all one value.
   */
  readonly source?: PriceSource | (string & {});
  /** Volume Profile: number of price buckets and the value-area share (default 70). */
  readonly buckets?: number;
  readonly valueAreaPercent?: number;
}

export interface IndicatorDefinition {
  readonly id: IndicatorId;
  readonly label: string;
  readonly placement: IndicatorPlacement;
  readonly defaults: IndicatorParams;
  /** Pure and total: never throws, returns NaN-padded arrays for short input. */
  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult;
}

export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';

/** The price fields a source may name, for building a picker. */
export const PRICE_SOURCES: readonly PriceSource[] = Object.freeze([
  'close',
  'open',
  'high',
  'low',
  'hl2',
  'hlc3',
  'ohlc4',
]);

/**
 * How each price source reads a bar.
 *
 * A `Record` over `PriceSource` rather than a switch, so adding a source without a reader
 * is a type error — and so the lookup below can be total over the WIDENED `source` type
 * without giving up that check.
 */
const PRICE_READERS: Readonly<Record<PriceSource, (bar: Bar) => number>> = Object.freeze({
  open: (bar) => bar.o,
  high: (bar) => bar.h,
  low: (bar) => bar.l,
  close: (bar) => bar.c,
  hl2: (bar) => (bar.h + bar.l) / 2,
  hlc3: (bar) => (bar.h + bar.l + bar.c) / 3,
  ohlc4: (bar) => (bar.o + bar.h + bar.l + bar.c) / 4,
});

const READERS = new Map<string, (bar: Bar) => number>(Object.entries(PRICE_READERS));

/**
 * Extracts the configured price source for a bar.
 *
 * A source that is not a price field is a reference to another indicator's plot, resolved
 * before the indicator is called (see `derived.ts`). Those bars arrive with `o`, `h`, `l`
 * and `c` all equal, so falling back to the close here is not a guess — every field would
 * give the same number.
 */
export function sourceValue(bar: Bar, source: IndicatorParams['source'] = 'close'): number {
  const read = READERS.get(source);
  return read === undefined ? bar.c : read(bar);
}
