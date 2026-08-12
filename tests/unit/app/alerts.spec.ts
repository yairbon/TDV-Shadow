import { describe, expect, it } from 'vitest';

import { createAlertStore, crossed, sideOf } from '../../../src/app/alerts.js';

/** `c` defaults to the midpoint: the close only matters where a test says it does. */
const bar = (
  h: number,
  l: number,
  c: number = (h + l) / 2,
  t = 0,
): { h: number; l: number; c: number; t: number } => ({ h, l, c, t });

describe('crossing', () => {
  it('fires when a bar reaches the level from below', () => {
    expect(crossed(100, 'below', bar(101, 98))).toBe(true);
    expect(crossed(100, 'below', bar(99.9, 98))).toBe(false);
  });

  it('fires when a bar reaches the level from above', () => {
    expect(crossed(100, 'above', bar(105, 99))).toBe(true);
    expect(crossed(100, 'above', bar(105, 100.1))).toBe(false);
  });

  it('never fires before a side is known', () => {
    // The first bar an alert sees only establishes which side of the level we are on;
    // firing on it would trigger every alert the moment it was created.
    expect(crossed(100, null, bar(200, 1))).toBe(false);
  });

  it('uses the bar RANGE, not the close', () => {
    // A spike through the level that closes back below still reached it. A close-only
    // test misses this, and misses it silently.
    expect(crossed(100, 'below', bar(104, 95, 96))).toBe(true);
  });

  it('treats touching the level as reaching it', () => {
    expect(crossed(100, 'below', bar(100, 98))).toBe(true);
    expect(crossed(100, 'above', bar(105, 100))).toBe(true);
  });
});

describe('sideOf', () => {
  it('puts a close exactly on the level above it', () => {
    expect(sideOf(100, 100)).toBe('above');
    expect(sideOf(100, 99.99)).toBe('below');
  });
});

describe('alert store', () => {
  it('arms on the first bar and fires on the second', () => {
    const store = createAlertStore();
    store.add('AAPL', 100);

    expect(store.observe('AAPL', bar(99, 97, 98))).toHaveLength(0);
    expect(store.forSymbol('AAPL')[0].side).toBe('below');

    const fired = store.observe('AAPL', bar(101, 98, 100.5, 42));
    expect(fired).toHaveLength(1);
    expect(fired[0].triggered).toBe(true);
    expect(fired[0].triggeredAt).toBe(42);
  });

  it('fires once, not on every subsequent bar', () => {
    const store = createAlertStore();
    store.add('AAPL', 100);
    store.observe('AAPL', bar(99, 97, 98));
    expect(store.observe('AAPL', bar(101, 98, 101))).toHaveLength(1);
    expect(store.observe('AAPL', bar(110, 105, 108))).toHaveLength(0);
    expect(store.observe('AAPL', bar(120, 115, 118))).toHaveLength(0);
  });

  it('ignores alerts belonging to another symbol', () => {
    const store = createAlertStore();
    store.add('MSFT', 100);
    store.observe('AAPL', bar(99, 97, 98));
    expect(store.observe('AAPL', bar(200, 1, 150))).toHaveLength(0);
    expect(store.forSymbol('MSFT')[0].side).toBeNull();
  });

  it('re-arms an alert that is moved', () => {
    // A level dragged somewhere new has not been reached yet; leaving it triggered would
    // make the moved alert dead on arrival.
    const store = createAlertStore();
    const alert = store.add('AAPL', 100);
    store.observe('AAPL', bar(99, 97, 98));
    store.observe('AAPL', bar(101, 98, 101));
    expect(store.get(alert.id)?.triggered).toBe(true);

    store.move(alert.id, 120);
    expect(store.get(alert.id)?.triggered).toBe(false);
    expect(store.get(alert.id)?.side).toBeNull();
    expect(store.get(alert.id)?.price).toBe(120);
  });

  it('reset re-arms without moving', () => {
    const store = createAlertStore();
    const alert = store.add('AAPL', 100);
    store.observe('AAPL', bar(99, 97, 98));
    store.observe('AAPL', bar(101, 98, 101));
    store.reset(alert.id);
    expect(store.get(alert.id)?.triggered).toBe(false);
    expect(store.get(alert.id)?.price).toBe(100);
  });

  it('notifies subscribers only when something actually changed', () => {
    const store = createAlertStore();
    store.add('AAPL', 100);
    store.observe('AAPL', bar(99, 97, 98));

    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    // Same side, no crossing: nothing to repaint.
    store.observe('AAPL', bar(99, 97, 98.5));
    expect(notified).toBe(0);

    store.observe('AAPL', bar(101, 98, 101));
    expect(notified).toBe(1);
  });

  it('round-trips through JSON', () => {
    const store = createAlertStore();
    store.add('AAPL', 100);
    store.add('AAPL', 250.5);
    store.observe('AAPL', bar(99, 97, 98));

    const restored = createAlertStore();
    expect(restored.loadJSON(store.toJSON())).toBe(2);
    expect(restored.forSymbol('AAPL').map((a) => a.price)).toEqual([100, 250.5]);
    expect(restored.forSymbol('AAPL')[0].side).toBe('below');
  });

  it('does not collide ids with restored alerts', () => {
    const store = createAlertStore();
    store.add('AAPL', 100);
    store.add('AAPL', 200);
    const restored = createAlertStore();
    restored.loadJSON(store.toJSON());
    expect(restored.add('AAPL', 300).id).toBe('a3');
  });

  it('drops entries with a non-finite price rather than the whole payload', () => {
    // A price read from localStorage ends up in a coordinate transform; NaN there
    // poisons a frame silently.
    const store = createAlertStore();
    const count = store.loadJSON(
      JSON.stringify({
        version: 1,
        alerts: [
          { id: 'a1', symbol: 'AAPL', price: 100 },
          { id: 'a2', symbol: 'AAPL', price: null },
          { id: 'a3', symbol: 'AAPL' },
          { id: 'a4', symbol: 'AAPL', price: 200 },
        ],
      }),
    );
    expect(count).toBe(2);
    expect(store.list().map((a) => a.price)).toEqual([100, 200]);
  });

  it('survives malformed JSON', () => {
    const store = createAlertStore();
    expect(store.loadJSON('{ not json')).toBe(0);
    expect(store.loadJSON('null')).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  it('clears one symbol without touching the others', () => {
    const store = createAlertStore();
    store.add('AAPL', 100);
    store.add('MSFT', 300);
    expect(store.clear('AAPL')).toBe(1);
    expect(store.list().map((a) => a.symbol)).toEqual(['MSFT']);
  });
});
