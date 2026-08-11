/**
 * Deterministic fixtures for renderer unit tests. Seeded, no clock, no randomness
 * that varies between runs.
 */

import {
  makeBar,
  type Bar,
  type PriceScaleMode,
  type Series,
  type SeriesState,
  type Snapshot,
  type Timeframe,
} from '../../../src/data/types.js';
import { computeLayout, type Layout } from '../../../src/renderer/layout.js';
import { DARK_THEME, type Theme } from '../../../src/renderer/theme.js';

/**
 * The shipped themes deliberately paint wicks and bodies the same colour, which
 * makes recorded fills ambiguous. Tests use a theme where all six series colours are
 * distinct so every `fillRect` can be attributed to exactly one pass.
 */
export const TEST_THEME: Theme = Object.freeze({
  ...DARK_THEME,
  name: 'test',
  upBody: '#up-body',
  downBody: '#down-body',
  upWick: '#up-wick',
  downWick: '#down-wick',
  upVolume: '#up-volume',
  downVolume: '#down-volume',
});

export function bar(t: number, o: number, h: number, l: number, c: number, v: number): Bar {
  const made = makeBar({ t, o, h, l, c, v });
  if (made === null) throw new Error(`invalid fixture bar at ${String(t)}`);
  return made;
}

/** Tiny LCG so the same series comes out on every machine and every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export const FIXTURE_START = 1_754_870_400_000; // 2025-08-11T00:00:00Z, a Monday

export function makeBars(count: number, stepMs = 60_000, seed = 7): Bar[] {
  const rand = lcg(seed);
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < count; i++) {
    const open = close;
    const drift = (rand() - 0.5) * 2;
    close = Math.max(1, open + drift);
    const high = Math.max(open, close) + rand();
    const low = Math.min(open, close) - rand();
    bars.push(bar(FIXTURE_START + i * stepMs, open, high, Math.max(0.5, low), close, 100 + rand() * 50));
  }
  return bars;
}

export function makeSeries(bars: readonly Bar[], tf: Timeframe = '1m', state: SeriesState = 'live'): Series {
  return Object.freeze({ symbol: 'BTCUSD', tf, bars, state, lastSeq: 1 });
}

export interface SnapshotOptions {
  readonly bars?: readonly Bar[];
  readonly tf?: Timeframe;
  readonly state?: SeriesState;
  readonly scrollPosition?: number;
  readonly barSpacing?: number;
  readonly priceScaleMode?: PriceScaleMode;
}

export function makeSnapshot(o: SnapshotOptions = {}): Snapshot {
  const bars = o.bars ?? makeBars(200);
  const barSpacing = o.barSpacing ?? 8;
  return Object.freeze({
    series: makeSeries(bars, o.tf ?? '1m', o.state ?? 'live'),
    scrollPosition: o.scrollPosition ?? bars.length - 1,
    barSpacing,
    priceScaleMode: o.priceScaleMode ?? 'linear',
    revision: 1,
  });
}

/** 800x600 chart with the standard gutters and a volume pane. */
export function testLayout(width = 800, height = 600, volumeFraction = 0.22): Layout {
  const d = DARK_THEME.density;
  return computeLayout({
    width,
    height,
    priceGutterWidth: d.priceGutterWidth,
    timeGutterHeight: d.timeGutterHeight,
    volumePaneFraction: volumeFraction,
    paneGap: d.paneGap,
    minPlotHeight: d.minPlotHeight,
  });
}
