/**
 * Undo / redo.
 *
 * Snapshot-based rather than inverse-command based. Inverse commands are smaller in
 * memory but every mutation needs a hand-written inverse, and one wrong inverse corrupts
 * state in a way that is very hard to trace. Drawing sets here are small (JSON of a few
 * shapes), so snapshotting is both simpler and safer.
 *
 * The invariant that makes it work: `capture()` is called BEFORE a mutation, so the top
 * of the undo stack is always the state to return to. Calling it after would record the
 * result and undo would appear to do nothing.
 */

import type { IndicatorId, IndicatorParams } from '../indicators/types.js';
import type { PlotStyles } from '../renderer/layers/annotationsLayer.js';

export interface HistoryState {
  /** Serialised drawing store. */
  readonly drawings: string;
  readonly indicators: readonly {
    readonly id: IndicatorId;
    readonly params: IndicatorParams;
    readonly styles: PlotStyles;
  }[];
}

export interface History {
  /** Records the CURRENT state before a mutation. Redo is dropped, as it now diverges. */
  capture(state: HistoryState): void;
  undo(current: HistoryState): HistoryState | null;
  redo(current: HistoryState): HistoryState | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
  depth(): { readonly undo: number; readonly redo: number };
}

const LIMIT = 60;

export function createHistory(limit = LIMIT): History {
  let undoStack: HistoryState[] = [];
  let redoStack: HistoryState[] = [];

  const same = (a: HistoryState, b: HistoryState): boolean =>
    a.drawings === b.drawings && JSON.stringify(a.indicators) === JSON.stringify(b.indicators);

  return {
    capture(state) {
      const top = undoStack[undoStack.length - 1];
      // Collapse no-op captures: a drag that ends where it started should not consume an
      // undo step, or the user presses Ctrl+Z and nothing appears to happen.
      if (undoStack.length > 0 && same(top, state)) return;
      undoStack = [...undoStack, state].slice(-limit);
      redoStack = [];
    },

    undo(current) {
      if (undoStack.length === 0) return null;
      const previous = undoStack[undoStack.length - 1];
      undoStack = undoStack.slice(0, -1);
      redoStack = [...redoStack, current].slice(-limit);
      return previous;
    },

    redo(current) {
      if (redoStack.length === 0) return null;
      const next = redoStack[redoStack.length - 1];
      redoStack = redoStack.slice(0, -1);
      undoStack = [...undoStack, current].slice(-limit);
      return next;
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    clear() {
      undoStack = [];
      redoStack = [];
    },
    depth: () => ({ undo: undoStack.length, redo: redoStack.length }),
  };
}
