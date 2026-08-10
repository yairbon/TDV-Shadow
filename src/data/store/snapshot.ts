/**
 * The frozen view handed to the renderer at frame start (root mandate #3).
 *
 * O(1), always: a snapshot is a five-field frozen wrapper around the *existing*
 * `Series` object. The bars array is referenced, never copied — copying 5000
 * bars per frame would eat the whole 8ms budget in skills/chart-render/SKILL.md
 * before a single candle is drawn.
 *
 * `revision` is monotonic and derived from the series and view revisions: equal
 * revisions mean identical content, so `scheduler` can skip a frame outright,
 * and the same frozen object is returned until something actually changes.
 */

import type { Series, Snapshot } from '../types.js';
import type { SeriesStore } from './seriesStore.js';
import type { ViewState, ViewStore } from './viewStore.js';

/** Builds one frozen `Snapshot`. No array copy, no per-bar work. */
export function createSnapshot(series: Series, view: ViewState, revision: number): Snapshot {
  return Object.freeze<Snapshot>({
    series,
    scrollPosition: view.scrollPosition,
    barSpacing: view.barSpacing,
    priceScaleMode: view.priceScaleMode,
    revision,
  });
}

export interface SnapshotSource {
  /** Same frozen object while nothing has changed. */
  snapshot(): Snapshot;
  /** Current combined revision without allocating a snapshot. */
  revision(): number;
  /** `true` when the caller's revision is behind — the scheduler's dirty check. */
  hasChangedSince(revision: number): boolean;
}

export function createSnapshotSource(series: SeriesStore, view: ViewStore): SnapshotSource {
  let seriesRevision = -1;
  let viewRevision = -1;
  let revision = 0;
  let cached: Snapshot | null = null;

  const isStale = (): boolean =>
    cached === null || series.revision() !== seriesRevision || view.revision() !== viewRevision;

  const snapshot = (): Snapshot => {
    const current = cached;
    if (current !== null && !isStale()) return current;
    seriesRevision = series.revision();
    viewRevision = view.revision();
    revision += 1;
    const next = createSnapshot(series.get(), view.get(), revision);
    cached = next;
    return next;
  };

  return Object.freeze<SnapshotSource>({
    snapshot,
    revision: () => {
      // Fold in any pending change so callers polling `revision()` alone still
      // see the transition; cheap, since `snapshot()` is O(1).
      return snapshot().revision;
    },
    hasChangedSince: (other) => snapshot().revision !== other,
  });
}
