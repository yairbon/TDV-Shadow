/**
 * FROZEN CONTRACT — the entire merge surface between the Phase 2A (data) and
 * Phase 2B (renderer) worktrees. Both subagents import from here; neither may
 * change it unilaterally. Any change requires both branches to be re-checked.
 *
 * Schema of record: docs/ARCHITECTURE.md §3. Coordinate math: docs/RENDER_ALGORITHMS.md.
 */

// ---------------------------------------------------------------------------
// Branded scalars (root CLAUDE.md mandate #6)
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A price in instrument quote units. */
export type Price = Brand<number, 'Price'>;
/** A CSS pixel (post-DPR-transform). Never a device pixel. */
export type Pixel = Brand<number, 'Pixel'>;
/** Integer index into a Series.bars array. Fractional only in scroll math. */
export type BarIndex = Brand<number, 'BarIndex'>;
/** Integer UTC epoch milliseconds. Always a bar OPEN time. */
export type TimeMs = Brand<number, 'TimeMs'>;

export const asPrice = (n: number): Price => n as Price;
export const asPixel = (n: number): Pixel => n as Pixel;
export const asBarIndex = (n: number): BarIndex => n as BarIndex;
export const asTimeMs = (n: number): TimeMs => n as TimeMs;

// ---------------------------------------------------------------------------
// Core data
// ---------------------------------------------------------------------------

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Milliseconds per timeframe bar. */
export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
});

/** One OHLCV bar. Immutable — mandate #4. Construct via `makeBar`. */
export interface Bar {
  /** UTC epoch ms of the bar OPEN. */
  readonly t: TimeMs;
  readonly o: Price;
  readonly h: Price;
  readonly l: Price;
  readonly c: Price;
  readonly v: number;
}

export type SeriesState = 'loading' | 'live' | 'stale';

export interface Series {
  readonly symbol: string;
  readonly tf: Timeframe;
  /** Ascending by `t`, no duplicates. Index space is dense (gaps take no width). */
  readonly bars: readonly Bar[];
  readonly state: SeriesState;
  /** Last WebSocket sequence number applied; -1 before the first message. */
  readonly lastSeq: number;
}

/** Immutable snapshot handed to the renderer at frame start. Mandate #3. */
export interface Snapshot {
  readonly series: Series;
  /** Fractional bar index at the plot's RIGHT edge. RENDER_ALGORITHMS §5 `k`. */
  readonly scrollPosition: number;
  /** CSS px per bar. RENDER_ALGORITHMS §5 `s`. Always > 0. */
  readonly barSpacing: number;
  readonly priceScaleMode: PriceScaleMode;
  /** Monotonic counter; equal values mean identical content. */
  readonly revision: number;
}

export type PriceScaleMode = 'linear' | 'log' | 'percent';

// ---------------------------------------------------------------------------
// Construction + validation (the ONLY place a Bar is created)
// ---------------------------------------------------------------------------

export interface BarInput {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
}

const isFiniteNumber = (n: number): boolean => Number.isFinite(n);

/**
 * Validates OHLCV invariants from ARCHITECTURE.md §3.1. Returns null instead of
 * throwing: a malformed tick is dropped and counted, never allowed to kill a frame.
 */
export function makeBar(input: BarInput): Bar | null {
  const { t, o, h, l, c, v } = input;
  if (!Number.isInteger(t) || t <= 0) return null;
  if (!isFiniteNumber(o) || !isFiniteNumber(h) || !isFiniteNumber(l) || !isFiniteNumber(c)) {
    return null;
  }
  if (!isFiniteNumber(v) || v < 0) return null;
  if (h < Math.max(o, c) || l > Math.min(o, c)) return null;
  if (h < l) return null;

  return Object.freeze<Bar>({
    t: asTimeMs(t),
    o: asPrice(o),
    h: asPrice(h),
    l: asPrice(l),
    c: asPrice(c),
    v,
  });
}

/** Wire tuple form: [t, o, h, l, c, v]. ARCHITECTURE.md §3.2. */
export type BarTuple = readonly [number, number, number, number, number, number];

export function barFromTuple(tuple: BarTuple): Bar | null {
  return makeBar({ t: tuple[0], o: tuple[1], h: tuple[2], l: tuple[3], c: tuple[4], v: tuple[5] });
}

/** Normalizes any timestamp to the open time of its containing bar. */
export function alignToBarOpen(t: number, tf: Timeframe): TimeMs {
  const step = TIMEFRAME_MS[tf];
  return asTimeMs(Math.floor(t / step) * step);
}
