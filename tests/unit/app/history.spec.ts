import { describe, expect, it } from 'vitest';

import { createHistory, type HistoryState } from '../../../src/app/history.js';

const state = (drawings: string, indicators: HistoryState['indicators'] = []): HistoryState => ({
  drawings,
  indicators,
});

describe('history', () => {
  it('starts empty', () => {
    const h = createHistory();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.undo(state('a'))).toBeNull();
    expect(h.redo(state('a'))).toBeNull();
  });

  it('returns the captured state, not the current one', () => {
    // The whole contract: capture() records what to go BACK to.
    const h = createHistory();
    h.capture(state('before'));
    expect(h.undo(state('after'))?.drawings).toBe('before');
  });

  it('round-trips undo and redo', () => {
    const h = createHistory();
    h.capture(state('a'));
    const undone = h.undo(state('b'));
    expect(undone?.drawings).toBe('a');
    expect(h.redo(state('a'))?.drawings).toBe('b');
  });

  it('collapses a repeated capture of the same state', () => {
    // A drag that ends where it began must not consume an undo step, or Ctrl+Z
    // appears to do nothing.
    const h = createHistory();
    h.capture(state('a'));
    h.capture(state('a'));
    h.capture(state('a'));
    expect(h.depth().undo).toBe(1);
  });

  it('does not collapse when only the indicators differ', () => {
    const h = createHistory();
    h.capture(state('a', [{ id: 'sma', params: { period: 20 } }]));
    h.capture(state('a', [{ id: 'sma', params: { period: 50 } }]));
    expect(h.depth().undo).toBe(2);
  });

  it('drops the redo stack on a new capture', () => {
    const h = createHistory();
    h.capture(state('a'));
    h.undo(state('b'));
    expect(h.canRedo()).toBe(true);
    h.capture(state('c'));
    expect(h.canRedo()).toBe(false);
  });

  it('walks back through several steps in order', () => {
    const h = createHistory();
    h.capture(state('a'));
    h.capture(state('b'));
    h.capture(state('c'));
    expect(h.undo(state('d'))?.drawings).toBe('c');
    expect(h.undo(state('c'))?.drawings).toBe('b');
    expect(h.undo(state('b'))?.drawings).toBe('a');
    expect(h.canUndo()).toBe(false);
  });

  it('evicts the oldest entries past the limit', () => {
    const h = createHistory(3);
    for (const d of ['a', 'b', 'c', 'd', 'e']) h.capture(state(d));
    expect(h.depth().undo).toBe(3);
    expect(h.undo(state('f'))?.drawings).toBe('e');
    expect(h.undo(state('e'))?.drawings).toBe('d');
    expect(h.undo(state('d'))?.drawings).toBe('c');
    expect(h.canUndo()).toBe(false);
  });

  it('clear() empties both stacks', () => {
    const h = createHistory();
    h.capture(state('a'));
    h.undo(state('b'));
    h.clear();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });
});
