import { describe, expect, it } from 'vitest';

import { asPrice } from '../../../src/data/types.js';
import { aggregateByColumn, shouldAggregate } from '../../../src/renderer/scale/lod.js';
import { makeBars } from './fixtures.js';

/** Deterministic bars with a single obvious spike, so a lost extreme is visible. */
const series = makeBars(100);
const spiked = series.map((bar, i) =>
  i === 37 ? Object.freeze({ ...bar, h: asPrice(bar.h + 500) }) : bar,
);

describe('shouldAggregate — §5.1', () => {
  it('is off at or above one pixel per bar', () => {
    expect(shouldAggregate(1, 500)).toBe(false);
    expect(shouldAggregate(8, 500)).toBe(false);
  });

  it('is on below one pixel per bar', () => {
    expect(shouldAggregate(0.5, 500)).toBe(true);
    expect(shouldAggregate(0.01, 100_000)).toBe(true);
  });

  it('is off for a single bar, where there is nothing to aggregate', () => {
    expect(shouldAggregate(0.01, 1)).toBe(false);
  });
});

describe('aggregateByColumn', () => {
  // 10 bars per pixel column.
  const x = (i: number) => i * 0.1;
  /** The same mapping in the affine form the function takes. */
  const affine = { x0: 0, dx: 0.1 };

  it('produces one entry per distinct pixel column', () => {
    const columns = aggregateByColumn(series, 0, 99, affine.x0, affine.dx);
    const distinct = new Set(series.map((_, i) => Math.round(x(i))));
    expect(columns).toHaveLength(distinct.size);
  });

  it('keeps the highest high and lowest low in each column', () => {
    // The property that matters: a spike inside a bucket must survive. Drawing every bar
    // into the same column instead loses it entirely, because the last bar paints over
    // the rest.
    const columns = aggregateByColumn(spiked, 0, 99, affine.x0, affine.dx);
    const spikeColumn = columns.find((c) => c.index <= 37 && 37 < c.index + 10);
    expect(spikeColumn?.h).toBe(spiked[37].h);

    for (const column of columns) {
      const members = spiked.filter((_, i) => Math.round(x(i)) === column.x);
      expect(column.h).toBe(Math.max(...members.map((b) => b.h)));
      expect(column.l).toBe(Math.min(...members.map((b) => b.l)));
    }
  });

  it('takes the open of the first bar and the close of the last', () => {
    const columns = aggregateByColumn(series, 0, 99, affine.x0, affine.dx);
    for (const column of columns) {
      const members = series.filter((_, i) => Math.round(x(i)) === column.x);
      expect(column.o).toBe(members[0].o);
      expect(column.c).toBe(members[members.length - 1].c);
    }
  });

  it('sums volume, so the volume pane still totals the same', () => {
    const columns = aggregateByColumn(series, 0, 99, affine.x0, affine.dx);
    const total = columns.reduce((sum, c) => sum + c.v, 0);
    expect(total).toBeCloseTo(
      series.reduce((sum, b) => sum + b.v, 0),
      6,
    );
  });

  it('buckets by PIXEL COLUMN, not by a fixed bar stride', () => {
    // A fixed stride would give identical bucket sizes regardless of the mapping; pixel
    // bucketing has to follow the mapping, or the series shimmers as the chart pans.
    const dense = aggregateByColumn(series, 0, 99, 0, 0.1);
    const sparse = aggregateByColumn(series, 0, 99, 0, 0.5);
    expect(sparse.length).toBeGreaterThan(dense.length);
  });

  it('is a no-op shape when every bar has its own column', () => {
    const columns = aggregateByColumn(series, 0, 99, 0, 4);
    expect(columns).toHaveLength(100);
    expect(columns[42].h).toBe(series[42].h);
    expect(columns[42].index).toBe(42);
  });

  it('clamps the requested range to the series', () => {
    expect(aggregateByColumn(series, -50, 500, affine.x0, affine.dx).length).toBeGreaterThan(0);
    expect(aggregateByColumn(series, 500, 900, affine.x0, affine.dx)).toHaveLength(0);
    expect(aggregateByColumn([], 0, 10, affine.x0, affine.dx)).toHaveLength(0);
  });

  it('reports the first bar of each column as its index', () => {
    const columns = aggregateByColumn(series, 0, 99, affine.x0, affine.dx);
    for (const column of columns) {
      const first = series.findIndex((_, i) => Math.round(x(i)) === column.x);
      expect(column.index).toBe(first);
    }
  });

  it('covers every bar in the range exactly once', () => {
    // No bar may be dropped: an aggregation that skips bars silently shortens history.
    const columns = aggregateByColumn(series, 0, 99, affine.x0, affine.dx);
    const covered = columns.reduce((sum, c) => {
      const members = series.filter((_, i) => Math.round(x(i)) === c.x);
      return sum + members.length;
    }, 0);
    expect(covered).toBe(100);
  });
});
