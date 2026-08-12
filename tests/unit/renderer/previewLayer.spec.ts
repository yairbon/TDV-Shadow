/**
 * What the placement preview actually paints.
 *
 * Measured on the real app, placing a trendline used to paint the SAME number of pixels
 * before the first click, after it, and all the way to the second click — the shape only
 * appeared once it was finished. So these tests assert the exact coordinates handed to
 * `moveTo`/`lineTo`/`fillRect`, and, crucially, that those coordinates CHANGE when the
 * cursor does. A test that only asked "was anything drawn" would have passed against the
 * broken build too, since the crosshair itself always draws.
 *
 * Geometry comes from `buildPreviewGeometry` rather than being hand-written, so the two
 * halves of the feature are exercised together: a preview that renders beautifully from a
 * fixture nobody produces is worth nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPreviewGeometry,
  type DrawingGeometry,
  type PriceProjector,
  type TimeProjector,
} from '../../../src/drawings/geometry.js';
import { DEFAULT_STYLE } from '../../../src/drawings/tools.js';
import type { Anchor, DrawingKind } from '../../../src/drawings/types.js';
import { drawDrawings } from '../../../src/renderer/layers/annotationsLayer.js';
import {
  drawPlacementPreview,
  PREVIEW_ALPHA,
  PREVIEW_DASH,
} from '../../../src/renderer/layers/previewLayer.js';
import { makeRect, type Rect } from '../../../src/renderer/layout.js';
import { snapFill, snapLine } from '../../../src/renderer/pixel.js';
import { FakeContext, type RecordedCall } from './fakeCanvas.js';
import { TEST_THEME } from './fixtures.js';

const PLOT: Rect = makeRect(0, 0, 1200, 600);

const price: PriceProjector = { y: (p) => (140 - p) * 10, price: (y) => 140 - y / 10 };
const time: TimeProjector = { x: (i) => 1200 - (49 - i) * 12, indexAt: (x) => 49 - (1200 - x) / 12 };

const A: Anchor = { barIndex: 5, price: 100 }; // -> (672, 400)
const B: Anchor = { barIndex: 20, price: 120 }; // -> (852, 200)
const C: Anchor = { barIndex: 35, price: 90 }; // -> (1032, 500)

function paint(geometry: DrawingGeometry, theme = TEST_THEME): FakeContext {
  const ctx = new FakeContext();
  drawPlacementPreview(ctx.asContext(), geometry, PLOT, theme);
  return ctx;
}

function preview(
  placed: readonly Anchor[],
  cursor: Anchor,
  kind: DrawingKind = 'trendline',
): FakeContext {
  return paint(buildPreviewGeometry(kind, placed, cursor, price, time, PLOT));
}

/** The dash pattern in force when `call` was recorded. */
function dashAt(ctx: FakeContext, call: RecordedCall): readonly number[] {
  const index = ctx.calls.indexOf(call);
  let dash: readonly number[] = [];
  for (let i = 0; i < index; i++) {
    const previous = ctx.calls[i];
    if (previous.op === 'setLineDash') dash = previous.args;
  }
  return dash;
}

describe('placement preview — the rubber band is painted', () => {
  it('strokes from the pinned anchor to the cursor', () => {
    const ctx = preview([A], B);

    expect(ctx.ops('moveTo').map((c) => c.args)).toEqual([[snapLine(672), snapLine(400)]]);
    expect(ctx.ops('lineTo').map((c) => c.args)).toEqual([[snapLine(852), snapLine(200)]]);
    expect(ctx.ops('stroke')).toHaveLength(1);
  });

  it('repaints somewhere else when the cursor moves', () => {
    // The bug, in one assertion: these two used to be byte-identical.
    const first = preview([A], B).ops('lineTo').map((c) => c.args);
    const second = preview([A], C).ops('lineTo').map((c) => c.args);

    expect(first).toEqual([[852.5, 200.5]]);
    expect(second).toEqual([[1032.5, 500.5]]);
    expect(first).not.toEqual(second);
  });

  it('draws a cursor marker with nothing clicked yet', () => {
    const ctx = preview([], B);

    // Hollow: a stroked box, not a filled one, and no pinned handles at all.
    expect(ctx.ops('strokeRect').map((c) => c.args)).toEqual([
      [snapLine(850), snapLine(198), 4, 4],
    ]);
    expect(ctx.ops('fillRect')).toHaveLength(0);
  });

  it('distinguishes pinned handles from the floating cursor', () => {
    const ctx = preview([A], B);

    // Pinned: solid 7px square centred on the placed anchor.
    expect(ctx.ops('fillRect').map((c) => c.args)).toEqual([[snapFill(672) - 3, snapFill(400) - 3, 7, 7]]);
    // Floating: smaller hollow 4px box on the cursor.
    expect(ctx.ops('strokeRect').map((c) => c.args)).toEqual([
      [snapLine(850), snapLine(198), 4, 4],
    ]);
  });

  it('pins one handle per placed anchor, and only those', () => {
    const twoPlaced = preview([A, B], C, 'pitchfork');

    expect(twoPlaced.ops('fillRect').map((c) => c.args)).toEqual([
      [snapFill(672) - 3, snapFill(400) - 3, 7, 7],
      [snapFill(852) - 3, snapFill(200) - 3, 7, 7],
    ]);
  });

  it('snaps every stroke to the §7 half-pixel grid', () => {
    const ctx = preview([A], B);
    for (const call of [...ctx.ops('moveTo'), ...ctx.ops('lineTo'), ...ctx.ops('strokeRect')]) {
      expect(call.args[0] % 1).toBe(0.5);
      expect(call.args[1] % 1).toBe(0.5);
    }
    for (const call of ctx.ops('fillRect')) {
      expect(call.args[0] % 1).toBe(0);
      expect(call.args[1] % 1).toBe(0);
    }
  });
});

describe('placement preview — reads as provisional', () => {
  it('strokes the shape dashed where a committed drawing is solid', () => {
    const geometry = buildPreviewGeometry('trendline', [A], B, price, time, PLOT);
    const previewCtx = paint(geometry);

    const committedCtx = new FakeContext();
    drawDrawings(
      committedCtx.asContext(),
      [{ ...geometry, complete: true, style: DEFAULT_STYLE }],
      PLOT,
      TEST_THEME,
      null,
    );

    expect(dashAt(previewCtx, previewCtx.ops('stroke')[0])).toEqual([...PREVIEW_DASH]);
    expect(dashAt(committedCtx, committedCtx.ops('stroke')[0])).toEqual([]);
  });

  it('dims the shape but not the pinned handles', () => {
    const ctx = preview([A], B);

    expect(ctx.ops('stroke')[0].globalAlpha).toBe(PREVIEW_ALPHA);
    expect(PREVIEW_ALPHA).toBeLessThan(1);
    // A placed anchor is a fact, not a proposal: full opacity.
    expect(ctx.ops('fillRect')[0].globalAlpha).toBe(1);
  });

  it('takes its colour from the theme rather than hard-coding one', () => {
    const ctx = preview([A], B);
    expect(ctx.ops('stroke')[0].strokeStyle).toBe(TEST_THEME.crosshairLine);
    expect(ctx.ops('fillRect')[0].fillStyle).toBe(TEST_THEME.crosshairLine);

    const recoloured = paint(buildPreviewGeometry('trendline', [A], B, price, time, PLOT), {
      ...TEST_THEME,
      crosshairLine: '#abcdef',
    });
    expect(recoloured.ops('stroke')[0].strokeStyle).toBe('#abcdef');
  });

  it('outlines a rectangle preview instead of filling it', () => {
    const ctx = paint(buildPreviewGeometry('rectangle', [A], B, price, time, PLOT));
    const box = ctx.ops('strokeRect').map((c) => c.args);

    expect(box).toContainEqual([snapLine(672), snapLine(200), 180, 200]);
    // Only the cursor marker and the box outline — no translucent body fill.
    expect(box).toHaveLength(2);
    expect(ctx.ops('fillRect').map((c) => c.args)).toEqual([[669, 397, 7, 7]]);
  });
});

describe('placement preview — layer hygiene', () => {
  it('clips to the plot before drawing anything', () => {
    const ctx = preview([A], B);
    const first = ctx.calls.slice(0, 4).map((c) => c.op);

    expect(first).toEqual(['save', 'beginPath', 'rect', 'clip']);
    expect(ctx.ops('rect')[0].args).toEqual([PLOT.left, PLOT.top, PLOT.width, PLOT.height]);
  });

  it('leaves the context exactly as it found it', () => {
    const ctx = preview([A], B);

    expect(ctx.depth).toBe(0);
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.calls[ctx.calls.length - 1].op).toBe('restore');
  });

  it('leaves the dash pattern cleared for whatever draws next', () => {
    const ctx = preview([A], B);
    const dashes = ctx.ops('setLineDash');

    expect(dashes[dashes.length - 1].args).toEqual([]);
  });

  it('paints nothing at all when there is nothing to preview', () => {
    const empty: DrawingGeometry = {
      id: 'x',
      kind: 'trendline',
      style: DEFAULT_STYLE,
      complete: false,
      segments: [],
      levels: [],
      points: [],
      labels: [],
      box: null,
    };

    expect(paint(empty).calls).toHaveLength(0);
  });
});
