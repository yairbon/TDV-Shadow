import { describe, expect, it } from 'vitest';
import {
  createViewStore,
  MAX_BAR_SPACING,
  MIN_BAR_SPACING,
} from '../../../src/data/store/viewStore.js';
import type { ViewState } from '../../../src/data/store/viewStore.js';

describe('viewStore', () => {
  it('starts frozen on the defaults and takes overrides', () => {
    const view = createViewStore();
    expect(Object.isFrozen(view.get())).toBe(true);
    expect(view.get().scrollPosition).toBe(0);
    expect(view.get().priceScaleMode).toBe('linear');

    const custom = createViewStore({ scrollPosition: 120.5, priceScaleMode: 'log' });
    expect(custom.get().scrollPosition).toBe(120.5);
    expect(custom.get().priceScaleMode).toBe('log');
  });

  it('keeps barSpacing strictly positive and inside its range', () => {
    const view = createViewStore();
    view.setBarSpacing(0);
    expect(view.get().barSpacing).toBe(MIN_BAR_SPACING);
    expect(view.get().barSpacing).toBeGreaterThan(0);

    view.setBarSpacing(-40);
    expect(view.get().barSpacing).toBe(MIN_BAR_SPACING);

    view.setBarSpacing(10_000);
    expect(view.get().barSpacing).toBe(MAX_BAR_SPACING);

    expect(createViewStore({ barSpacing: 0 }).get().barSpacing).toBe(MIN_BAR_SPACING);
  });

  it('accepts a fractional scroll position — k is fractional by design (§5)', () => {
    const view = createViewStore();
    expect(view.setScrollPosition(1023.75)).toBe(true);
    expect(view.get().scrollPosition).toBe(1023.75);
    expect(view.scrollBy(-3.5)).toBe(true);
    expect(view.get().scrollPosition).toBe(1020.25);
  });

  it('refuses NaN and Infinity instead of poisoning the scales', () => {
    const view = createViewStore();
    expect(view.setScrollPosition(Number.NaN)).toBe(false);
    expect(view.setBarSpacing(Number.POSITIVE_INFINITY)).toBe(false);
    expect(view.scrollBy(Number.NaN)).toBe(false);
    expect(view.get().scrollPosition).toBe(0);
    expect(view.revision()).toBe(0);
  });

  it('moves the revision only on a real change', () => {
    const view = createViewStore();
    const seen: ViewState[] = [];
    view.subscribe((next) => seen.push(next));

    expect(view.setBarSpacing(12)).toBe(true);
    expect(view.setBarSpacing(12)).toBe(false);
    expect(view.setPriceScaleMode('linear')).toBe(false);
    expect(view.setPriceScaleMode('log')).toBe(true);

    expect(view.revision()).toBe(2);
    expect(seen).toHaveLength(2);
  });

  it('applies a pan+zoom as one atomic change', () => {
    const view = createViewStore();
    let notifications = 0;
    view.subscribe(() => {
      notifications += 1;
    });

    expect(view.update({ scrollPosition: 500, barSpacing: 3 })).toBe(true);

    expect(notifications).toBe(1);
    expect(view.revision()).toBe(1);
    expect(view.get()).toEqual({ scrollPosition: 500, barSpacing: 3, priceScaleMode: 'linear' });
  });

  it('unsubscribes cleanly', () => {
    const view = createViewStore();
    let calls = 0;
    const off = view.subscribe(() => {
      calls += 1;
    });
    view.setBarSpacing(20);
    off();
    view.setBarSpacing(30);
    expect(calls).toBe(1);
  });
});
