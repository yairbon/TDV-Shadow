/**
 * callout — a text box at anchor 1 with a leader line back to anchor 0.
 *
 * The box is sized in pixels from the text, because geometry has no font metrics; the
 * things worth asserting are that it is anchored to the SECOND anchor (a callout whose box
 * sits on the thing it is annotating is useless), that the leader reaches the box edge
 * facing the target rather than cutting across the text, and that neither of those depends
 * on the price scale — the box is chrome, so it is the same 22px tall on a log chart.
 */

import { describe, expect, it } from 'vitest';

import { buildGeometry, buildPreviewGeometry } from '../../../src/drawings/geometry.js';
import { hitTest } from '../../../src/drawings/hitTest.js';
import type { Anchor, Drawing } from '../../../src/drawings/types.js';
import { A, B, C, PLOT, logPrice, makeDrawing, price, time, zoomedTime } from './projectors.js';

const callout = (target: Anchor, at: Anchor, params: Drawing['params'] = {}) =>
  buildGeometry(makeDrawing('callout', [target, at], params), price, time, PLOT);

describe('callout geometry', () => {
  it('boxes the note at the SECOND anchor, centred on it vertically', () => {
    // Default text "Note": 4 chars * 6px + 2 * 6px padding = 36px wide, 22px tall.
    const geometry = callout(A, B);

    expect(geometry.complete).toBe(true);
    expect(geometry.box).toEqual({ x0: 852, y0: 189, x1: 888, y1: 211 });
  });

  it('runs the leader from the target anchor to the box', () => {
    const geometry = callout(A, B);

    expect(geometry.segments).toEqual([{ from: { x: 672, y: 400 }, to: { x: 852, y: 200 } }]);
  });

  it('attaches the leader to the edge FACING the target', () => {
    // Target to the right of the box: attaching at the left edge would drag the line
    // straight through the text.
    const fromRight = callout(C, B);

    expect(fromRight.segments[0].from).toEqual({ x: 1032, y: 500 });
    expect(fromRight.segments[0].to).toEqual({ x: 888, y: 200 });
    expect(fromRight.segments[0].to.x).toBe(fromRight.box?.x1);
  });

  it('widens the box with the text, and keeps its height', () => {
    const short = callout(A, B, { text: 'Hi' });
    const long = callout(A, B, { text: 'Breakout retest' });

    expect(short.box).toEqual({ x0: 852, y0: 189, x1: 876, y1: 211 });
    expect(long.box).toEqual({ x0: 852, y0: 189, x1: 954, y1: 211 });
    expect((long.box?.x1 ?? 0) - (short.box?.x1 ?? 0)).toBe(13 * 6);
  });

  it('still boxes an empty note, at twice the padding', () => {
    expect(callout(A, B, { text: '' }).box).toEqual({ x0: 852, y0: 189, x1: 864, y1: 211 });
  });

  it('honours the metric params', () => {
    const geometry = callout(A, B, { text: 'Hi', charWidth: 10, padding: 4, boxHeight: 40 });

    expect(geometry.box).toEqual({ x0: 852, y0: 180, x1: 880, y1: 220 });
  });

  it('puts the text inside the box, on its centre line', () => {
    const geometry = callout(A, B);

    expect(geometry.labels).toEqual([{ x: 852, y: 200, text: 'Note' }]);
    // The renderer insets label text by 6px — the default padding — so it lands inside.
    expect(geometry.labels[0].x + 6).toBeGreaterThan(geometry.box?.x0 ?? 0);
    expect(geometry.labels[0].y).toBe(((geometry.box?.y0 ?? 0) + (geometry.box?.y1 ?? 0)) / 2);
  });

  it('keeps both anchors grabbable', () => {
    expect(callout(A, B).points).toEqual([
      { x: 672, y: 400 },
      { x: 852, y: 200 },
    ]);
  });
});

describe('callout and the anchor rule', () => {
  const drawing = makeDrawing('callout', [A, B]);

  it('moves the whole callout when the view zooms, without resizing the box', () => {
    const before = buildGeometry(drawing, price, time, PLOT);
    const after = buildGeometry(drawing, price, zoomedTime, PLOT);

    expect(after.box).toEqual({ x0: 800, y0: 189, x1: 836, y1: 211 });
    expect(after.segments[0]).toEqual({ from: { x: 200, y: 400 }, to: { x: 800, y: 200 } });
    // Same box, 600px to the left: the note is chrome, its size is not data-derived.
    expect((after.box?.x1 ?? 0) - (after.box?.x0 ?? 0)).toBe(
      (before.box?.x1 ?? 0) - (before.box?.x0 ?? 0),
    );
    expect(drawing.anchors).toEqual([A, B]);
  });

  it('keeps its pixel size on a LOG scale, where every y moves', () => {
    const logged = buildGeometry(drawing, logPrice, time, PLOT);

    expect((logged.box?.y1 ?? 0) - (logged.box?.y0 ?? 0)).toBe(22);
    expect(logged.box?.y0).toBeCloseTo(logPrice.y(120) - 11, 9);
    expect(logged.box?.y0).not.toBeCloseTo(price.y(120) - 11, 3);
  });
});

describe('callout hit testing', () => {
  const geometry = callout(A, B);

  it('hits a click on the leader line', () => {
    expect(hitTest({ x: 762, y: 300 }, [geometry], 6)).toHaveLength(1);
  });

  it('hits a click on the box border', () => {
    expect(hitTest({ x: 870, y: 189 }, [geometry], 6)).toHaveLength(1);
  });

  it('misses a click below the box', () => {
    expect(hitTest({ x: 870, y: 260 }, [geometry], 6)).toHaveLength(0);
  });

  it('reports the box anchor when it is grabbed', () => {
    expect(hitTest({ x: 852, y: 200 }, [geometry], 6)[0].anchorIndex).toBe(1);
  });
});

describe('callout preview', () => {
  it('drags the box while the target stays pinned', () => {
    const first = buildPreviewGeometry('callout', [A], B, price, time, PLOT);
    const second = buildPreviewGeometry('callout', [A], C, price, time, PLOT);

    expect(first.complete).toBe(false);
    expect(first.segments[0].from).toEqual({ x: 672, y: 400 });
    expect(second.segments[0].from).toEqual({ x: 672, y: 400 });
    expect(first.box).toEqual({ x0: 852, y0: 189, x1: 888, y1: 211 });
    expect(second.box).toEqual({ x0: 1032, y0: 489, x1: 1068, y1: 511 });
    expect(second.labels[0].text).toBe('Note');
  });
});
