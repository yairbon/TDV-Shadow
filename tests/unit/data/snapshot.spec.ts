import { describe, expect, it } from 'vitest';
import { createSeriesStore } from '../../../src/data/store/seriesStore.js';
import { createViewStore } from '../../../src/data/store/viewStore.js';
import { createSnapshotSource } from '../../../src/data/store/snapshot.js';
import { bar, MINUTE, T0 } from './_helpers.js';

function fixture(barCount = 5): {
  readonly series: ReturnType<typeof createSeriesStore>;
  readonly view: ReturnType<typeof createViewStore>;
  readonly source: ReturnType<typeof createSnapshotSource>;
} {
  const series = createSeriesStore({ symbol: 'BTCUSD', tf: '1m' });
  for (let i = 0; i < barCount; i += 1) series.append(bar(T0 + i * MINUTE));
  const view = createViewStore({ scrollPosition: barCount - 1, barSpacing: 8 });
  return { series, view, source: createSnapshotSource(series, view) };
}

describe('snapshot', () => {
  it('is frozen and carries the view scalars alongside the series', () => {
    const { source } = fixture();
    const snapshot = source.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.scrollPosition).toBe(4);
    expect(snapshot.barSpacing).toBe(8);
    expect(snapshot.priceScaleMode).toBe('linear');
    expect(snapshot.series.bars).toHaveLength(5);
  });

  it('references the bars array — never copies it', () => {
    const { series, source } = fixture(5_000);
    const snapshot = source.snapshot();

    expect(snapshot.series).toBe(series.get());
    expect(snapshot.series.bars).toBe(series.get().bars);
  });

  it('returns the very same object while nothing has changed', () => {
    const { source } = fixture();
    const first = source.snapshot();

    expect(source.snapshot()).toBe(first);
    expect(source.snapshot().revision).toBe(first.revision);
  });

  it('mints a new snapshot after a series change and after a view change', () => {
    const { series, view, source } = fixture();
    const first = source.snapshot();

    series.append(bar(T0 + 99 * MINUTE));
    const afterSeries = source.snapshot();
    expect(afterSeries).not.toBe(first);
    expect(afterSeries.revision).toBeGreaterThan(first.revision);

    view.setBarSpacing(12);
    const afterView = source.snapshot();
    expect(afterView).not.toBe(afterSeries);
    expect(afterView.revision).toBeGreaterThan(afterSeries.revision);
    expect(afterView.barSpacing).toBe(12);
  });

  it('does not move the revision for a no-op write — equal revisions mean equal content', () => {
    const { series, view, source } = fixture();
    const first = source.snapshot();

    series.replaceLast(series.get().bars[series.get().bars.length - 1]); // identical content
    view.setBarSpacing(8); // already 8

    expect(source.snapshot()).toBe(first);
    expect(source.hasChangedSince(first.revision)).toBe(false);
  });

  it('hasChangedSince is the scheduler dirty check', () => {
    const { series, source } = fixture();
    const revision = source.revision();

    expect(source.hasChangedSince(revision)).toBe(false);
    series.setState('stale');
    expect(source.hasChangedSince(revision)).toBe(true);
  });
});
