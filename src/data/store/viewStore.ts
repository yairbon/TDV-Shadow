/**
 * Viewport state: `scrollPosition` (k), `barSpacing` (s), price scale mode.
 *
 * k and s are RENDER_ALGORITHMS §5's symbols — k is the *fractional* bar index
 * at the plot's right edge, s is CSS px per bar. The store holds them and
 * nothing else: no pixels, no plot rect, no zoom anchoring. Those live in the
 * renderer's timeScale, which is the only place allowed to do coordinate math.
 *
 * Like the series store, `revision` moves only when a value actually changes,
 * so a pointer stream that re-sends the same k costs no frames.
 */

import type { PriceScaleMode } from '../types.js';

export interface ViewState {
  /** Fractional bar index at the right edge (§5 `k`). */
  readonly scrollPosition: number;
  /** CSS px per bar (§5 `s`). Always > 0. */
  readonly barSpacing: number;
  readonly priceScaleMode: PriceScaleMode;
}

/** Below this, candles collapse into sub-pixel noise; above it they read as blocks. */
export const MIN_BAR_SPACING = 0.01;
export const MAX_BAR_SPACING = 200;

export const DEFAULT_VIEW: ViewState = Object.freeze<ViewState>({
  scrollPosition: 0,
  barSpacing: 8,
  priceScaleMode: 'linear',
});

export interface ViewStore {
  get(): ViewState;
  revision(): number;
  /** Rejects non-finite input; returns `true` only on a real change. */
  setScrollPosition(k: number): boolean;
  scrollBy(deltaBars: number): boolean;
  /** Clamped to [MIN_BAR_SPACING, MAX_BAR_SPACING]. */
  setBarSpacing(s: number): boolean;
  setPriceScaleMode(mode: PriceScaleMode): boolean;
  /** Atomic pan+zoom: one revision bump, one notify. */
  update(patch: Partial<ViewState>): boolean;
  subscribe(listener: (view: ViewState) => void): () => void;
}

const clampSpacing = (s: number): number =>
  Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, s));

export function createViewStore(initial: Partial<ViewState> = {}): ViewStore {
  let view: ViewState = Object.freeze<ViewState>({
    scrollPosition: Number.isFinite(initial.scrollPosition ?? DEFAULT_VIEW.scrollPosition)
      ? (initial.scrollPosition ?? DEFAULT_VIEW.scrollPosition)
      : DEFAULT_VIEW.scrollPosition,
    barSpacing: clampSpacing(
      Number.isFinite(initial.barSpacing ?? DEFAULT_VIEW.barSpacing)
        ? (initial.barSpacing ?? DEFAULT_VIEW.barSpacing)
        : DEFAULT_VIEW.barSpacing,
    ),
    priceScaleMode: initial.priceScaleMode ?? DEFAULT_VIEW.priceScaleMode,
  });

  let revision = 0;
  const listeners = new Set<(view: ViewState) => void>();

  const commit = (next: ViewState): boolean => {
    if (
      next.scrollPosition === view.scrollPosition &&
      next.barSpacing === view.barSpacing &&
      next.priceScaleMode === view.priceScaleMode
    ) {
      return false;
    }
    view = Object.freeze(next);
    revision += 1;
    for (const listener of [...listeners]) listener(view);
    return true;
  };

  const update = (patch: Partial<ViewState>): boolean => {
    const k = patch.scrollPosition ?? view.scrollPosition;
    const s = patch.barSpacing ?? view.barSpacing;
    if (!Number.isFinite(k) || !Number.isFinite(s)) return false;
    return commit({
      scrollPosition: k,
      barSpacing: clampSpacing(s),
      priceScaleMode: patch.priceScaleMode ?? view.priceScaleMode,
    });
  };

  return Object.freeze<ViewStore>({
    get: () => view,
    revision: () => revision,
    setScrollPosition: (k) => update({ scrollPosition: k }),
    scrollBy: (deltaBars) =>
      Number.isFinite(deltaBars)
        ? update({ scrollPosition: view.scrollPosition + deltaBars })
        : false,
    setBarSpacing: (s) => update({ barSpacing: s }),
    setPriceScaleMode: (mode) => update({ priceScaleMode: mode }),
    update,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}
