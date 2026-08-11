/**
 * Store operations behind the Phase 7.3 context menu.
 *
 * Each of these covers a behaviour the menu needs and the store did not have — or, in
 * two cases, had backwards.
 */

import { describe, expect, it } from 'vitest';

import { createDrawingStore } from '../../../src/drawings/store.js';

const anchors = [
  { barIndex: 10, price: 100 },
  { barIndex: 20, price: 120 },
];

describe('drawing store — locking', () => {
  it('refuses a geometry change on a locked drawing', () => {
    const store = createDrawingStore();
    const drawing = store.add('trendline', anchors);
    store.update(drawing.id, { locked: true });
    store.update(drawing.id, { anchors: [{ barIndex: 0, price: 0 }] });
    expect(store.get(drawing.id)?.anchors).toEqual(anchors);
  });

  it('still allows the lock itself to be lifted', () => {
    // The original guard rejected EVERY patch on a locked drawing, so `locked: false`
    // could never be applied and locking was one-way.
    const store = createDrawingStore();
    const drawing = store.add('trendline', anchors);
    store.update(drawing.id, { locked: true });
    store.update(drawing.id, { locked: false });
    expect(store.get(drawing.id)?.locked).toBe(false);
    store.update(drawing.id, { anchors: [{ barIndex: 5, price: 50 }] });
    expect(store.get(drawing.id)?.anchors).toHaveLength(1);
  });

  it('allows visibility to change while locked', () => {
    const store = createDrawingStore();
    const drawing = store.add('trendline', anchors);
    store.update(drawing.id, { locked: true });
    store.update(drawing.id, { visible: false });
    expect(store.get(drawing.id)?.visible).toBe(false);
  });
});

describe('drawing store — duplicate', () => {
  it('copies the shape under a fresh id', () => {
    const store = createDrawingStore();
    const source = store.add('rectangle', anchors);
    const copy = store.duplicate(source.id);
    expect(copy).not.toBeNull();
    expect(copy?.id).not.toBe(source.id);
    expect(copy?.kind).toBe('rectangle');
    expect(copy?.anchors).toEqual(anchors);
    expect(store.list()).toHaveLength(2);
  });

  it('offsets the copy in DATA space, not pixels', () => {
    const store = createDrawingStore();
    const source = store.add('trendline', anchors);
    const copy = store.duplicate(source.id, { barIndex: 3, price: -5 });
    expect(copy?.anchors[0]).toEqual({ barIndex: 13, price: 95 });
    expect(copy?.anchors[1]).toEqual({ barIndex: 23, price: 115 });
  });

  it('does not carry the lock over to the copy', () => {
    // Cloning a locked shape to get an editable one is the whole point of cloning it.
    const store = createDrawingStore();
    const source = store.add('trendline', anchors);
    store.update(source.id, { locked: true });
    expect(store.duplicate(source.id)?.locked).toBe(false);
  });

  it('returns null for an unknown id', () => {
    expect(createDrawingStore().duplicate('nope')).toBeNull();
  });

  it('leaves the original untouched when the copy is edited', () => {
    const store = createDrawingStore();
    const source = store.add('trendline', anchors);
    const copy = store.duplicate(source.id);
    store.update(copy?.id ?? '', { anchors: [{ barIndex: 0, price: 0 }] });
    expect(store.get(source.id)?.anchors).toEqual(anchors);
  });
});

describe('drawing store — paint order', () => {
  it('sends a drawing to the back and brings it to the front', () => {
    const store = createDrawingStore();
    const a = store.add('trendline', anchors);
    const b = store.add('trendline', anchors);
    const c = store.add('trendline', anchors);

    expect(store.reorder(c.id, 'back')).toBe(true);
    expect(store.list().map((d) => d.id)).toEqual([c.id, a.id, b.id]);

    expect(store.reorder(c.id, 'front')).toBe(true);
    expect(store.list().map((d) => d.id)).toEqual([a.id, b.id, c.id]);
  });

  it('reports no-ops rather than bumping the revision for nothing', () => {
    const store = createDrawingStore();
    const a = store.add('trendline', anchors);
    store.add('trendline', anchors);
    const revision = store.revision();
    expect(store.reorder(a.id, 'back')).toBe(false);
    expect(store.reorder('missing', 'front')).toBe(false);
    expect(store.revision()).toBe(revision);
  });
});

describe('drawing store — selection', () => {
  it('notifies subscribers, because selection is painted', () => {
    // Selection draws a highlight and anchor handles. A silent change left the previous
    // selection on screen until something else forced a repaint.
    const store = createDrawingStore();
    const drawing = store.add('trendline', anchors);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.select(drawing.id);
    expect(notified).toBe(1);
    expect(store.selected()).toBe(drawing.id);
  });

  it('does not notify when the selection is unchanged', () => {
    const store = createDrawingStore();
    const drawing = store.add('trendline', anchors);
    store.select(drawing.id);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.select(drawing.id);
    expect(notified).toBe(0);
  });

  it('clears the selection when the selected drawing is removed', () => {
    const store = createDrawingStore();
    const drawing = store.add('trendline', anchors);
    store.select(drawing.id);
    store.remove(drawing.id);
    expect(store.selected()).toBeNull();
  });
});
