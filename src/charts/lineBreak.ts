/**
 * Line Break, Kagi and Point & Figure — the remaining price-driven types.
 *
 * All three emit a bar count unrelated to the input, so each output carries the
 * `sourceIndex` of the bar that closed it (see charts/types.ts).
 */

import type { Bar } from '../data/types.js';
import { makeDerived, resolveBrickSize } from './shared.js';
import type { ChartTypeParams, ChartTypeTransform, DerivedBar, DerivedSeries } from './types.js';

const MAX_BOXES_PER_BAR = 500;

/**
 * Line Break: a new line forms only when the close exceeds the extreme of the previous
 * `lineBreaks` lines (classic default 3). Comparing against only the last line would
 * make it a step chart — the look-back is the entire filter.
 */
export function lineBreakBars(bars: readonly Bar[], params: ChartTypeParams): DerivedBar[] {
  const out: DerivedBar[] = [];
  if (bars.length === 0) return out;

  const lookback = Math.max(1, Math.floor(params.lineBreaks ?? 3));
  let previousClose: number = bars[0].c;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const close: number = bar.c;

    if (out.length === 0) {
      if (close === previousClose) continue;
      const rising = close > previousClose;
      out.push(makeDerived(bar, i, previousClose, Math.max(previousClose, close), Math.min(previousClose, close), close, bar.v, rising));
      previousClose = close;
      continue;
    }

    const window = out.slice(Math.max(0, out.length - lookback));
    let high = -Infinity;
    let low = Infinity;
    for (const line of window) {
      high = Math.max(high, line.o, line.c);
      low = Math.min(low, line.o, line.c);
    }

    if (close > high || close < low) {
      const open = out[out.length - 1].c;
      const rising = close > open;
      out.push(makeDerived(bar, i, open, Math.max(open, close), Math.min(open, close), close, bar.v, rising));
    }
  }
  return out;
}

/**
 * Kagi: the line reverses only after a move of `reversal` (absolute, or a percent of
 * the current level when `kagiPercent`). Direction changes are what matter; each output
 * bar spans the segment between reversals.
 */
export function kagiBars(bars: readonly Bar[], params: ChartTypeParams): DerivedBar[] {
  const out: DerivedBar[] = [];
  if (bars.length === 0) return out;

  const configured = params.reversal ?? 0;
  const percent = params.kagiPercent === true;
  let anchor: number = bars[0].c;
  let extreme: number = bars[0].c;
  let direction = 0;

  const threshold = (level: number): number => {
    if (configured > 0) return percent ? Math.abs(level) * (configured / 100) : configured;
    return resolveBrickSize(bars, null);
  };

  const emit = (index: number, rising: boolean): void => {
    const bar = bars[index];
    out.push(
      makeDerived(bar, index, anchor, Math.max(anchor, extreme), Math.min(anchor, extreme), extreme, bar.v, rising),
    );
  };

  for (let i = 1; i < bars.length; i++) {
    const close: number = bars[i].c;
    const limit = threshold(extreme);
    if (!(limit > 0)) continue;

    // Direction must be ESTABLISHED before tracking an extreme. Letting both branches
    // run while direction is 0 makes `extreme` follow every close, so the reversal test
    // compares a value against itself and the series never turns — it emitted nothing.
    if (direction === 0) {
      if (close - anchor >= limit) {
        direction = 1;
        extreme = close;
      } else if (anchor - close >= limit) {
        direction = -1;
        extreme = close;
      }
      continue;
    }

    if (direction > 0) {
      if (close > extreme) {
        extreme = close;
      } else if (extreme - close >= limit) {
        emit(i, true);
        anchor = extreme;
        extreme = close;
        direction = -1;
      }
      continue;
    }

    if (close < extreme) {
      extreme = close;
    } else if (close - extreme >= limit) {
      emit(i, false);
      anchor = extreme;
      extreme = close;
      direction = 1;
    }
  }

  // Flush the segment still in progress, otherwise a series that trends without ever
  // reversing produces no bars at all.
  if (direction !== 0 && extreme !== anchor) emit(bars.length - 1, direction > 0);
  return out;
}

/**
 * Point & Figure: columns of X (rising) or O (falling) in `boxSize` increments, flipping
 * after `reversalBoxes` boxes against the column. Each output bar is one column.
 */
export function pointAndFigureBars(bars: readonly Bar[], params: ChartTypeParams): DerivedBar[] {
  const out: DerivedBar[] = [];
  if (bars.length === 0) return out;

  const box = resolveBrickSize(bars, params.boxSize);
  if (!(box > 0)) return out;
  const reversal = Math.max(1, Math.floor(params.reversalBoxes ?? 3));

  let direction = 0;
  let columnLow: number = bars[0].l;
  let columnHigh: number = bars[0].h;
  let sourceIndex = 0;
  let volume = 0;

  const flush = (index: number): void => {
    if (direction === 0) return;
    const bar = bars[index];
    const rising = direction > 0;
    out.push(
      makeDerived(
        bar,
        sourceIndex,
        rising ? columnLow : columnHigh,
        columnHigh,
        columnLow,
        rising ? columnHigh : columnLow,
        volume,
        rising,
      ),
    );
    volume = 0;
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    volume += bar.v;
    let guard = 0;

    for (;;) {
      if (++guard > MAX_BOXES_PER_BAR) break;

      if (direction === 0) {
        if (bar.h - columnLow >= box) {
          direction = 1;
          columnHigh = bar.h;
          sourceIndex = i;
        } else if (columnHigh - bar.l >= box) {
          direction = -1;
          columnLow = bar.l;
          sourceIndex = i;
        }
        break;
      }

      if (direction > 0) {
        if (bar.h > columnHigh) {
          columnHigh = bar.h;
          sourceIndex = i;
          break;
        }
        if (columnHigh - bar.l >= box * reversal) {
          flush(i);
          direction = -1;
          columnLow = bar.l;
          columnHigh = bar.h;
          sourceIndex = i;
          continue;
        }
        break;
      }

      if (bar.l < columnLow) {
        columnLow = bar.l;
        sourceIndex = i;
        break;
      }
      if (bar.h - columnLow >= box * reversal) {
        flush(i);
        direction = 1;
        columnHigh = bar.h;
        columnLow = bar.l;
        sourceIndex = i;
        continue;
      }
      break;
    }
  }
  flush(bars.length - 1);
  return out;
}

function resample(
  type: 'line-break' | 'kagi' | 'point-and-figure',
  style: DerivedSeries['style'],
  compute: (bars: readonly Bar[], params: ChartTypeParams) => DerivedBar[],
): ChartTypeTransform {
  return {
    type,
    style,
    preservesIndexSpace: false,
    transform: (bars, params) =>
      Object.freeze<DerivedSeries>({
        type,
        style,
        bars: Object.freeze(compute(bars, params)),
        preservesIndexSpace: false,
        baseline: null,
      }),
  };
}

export const lineBreakTransform = resample('line-break', 'brick', lineBreakBars);
export const kagiTransform = resample('kagi', 'brick', kagiBars);
export const pointAndFigureTransform = resample('point-and-figure', 'brick', pointAndFigureBars);
