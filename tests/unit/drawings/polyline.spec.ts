/**
 * polyline — an OPEN path through every anchor.
 *
 * Two failure modes are worth spending assertions on. Closing the loop back to the first
 * anchor turns the path into a polygon and hands the hit tester a chord across chart the
 * user never drew; and a path that connects the wrong pairs still produces "some segments"
 * from "some anchors", which is why the legs are checked for continuity rather than
 * counted.
 */

import { describe, expect, it } from 'vitest';

import { buildGeometry, buildPreviewGeometry, projectAnchor } from '../../../src/drawings/geometry.js';
import { hitTest } from '../../../src/drawings/hitTest.js';
import { TOOL_DEFINITIONS } from '../../../src/drawings/tools.js';
import type { Anchor } from '../../../src/drawings/types.js';
import { PLOT, makeDrawing, price, time, zoomedTime } from './projectors.js';

/** A zigzag on round pixels: x = 672 + 60i, y alternating 400 / 300. */
const ZIGZAG: readonly Anchor[] = Array.from({ length: 8 }, (_, i) => ({
  barIndex: 5 + i * 5,
  price: i % 2 === 0 ? 100 : 110,
}));

const geometry = buildGeometry(makeDrawing('polyline', ZIGZAG), price, time, PLOT);

describe('polyline geometry', () => {
  it('collects up to eight anchors but is a finished path from two', () => {
    // Eight is a ceiling, not a shape: placement stops there on its own, and the user can
    // finish sooner. Requiring all eight would mean a four-legged path renders as nothing.
    expect(TOOL_DEFINITIONS.polyline.anchorCount).toBe(8);
    expect(TOOL_DEFINITIONS.polyline.minAnchorCount).toBe(2);

    for (const count of [2, 3, 5, 7]) {
      const partial = buildGeometry(makeDrawing('polyline', ZIGZAG.slice(0, count)), price, time, PLOT);
      expect(partial.complete).toBe(true);
      expect(partial.segments).toHaveLength(count - 1);
    }

    // One anchor is a point, not a path, and has no segment to draw.
    const single = buildGeometry(makeDrawing('polyline', ZIGZAG.slice(0, 1)), price, time, PLOT);
    expect(single.complete).toBe(false);
    expect(single.segments).toHaveLength(0);
  });

  it('strings one leg between each consecutive pair', () => {
    expect(geometry.complete).toBe(true);
    expect(geometry.segments).toHaveLength(ZIGZAG.length - 1);
    expect(geometry.segments[0]).toEqual({ from: { x: 672, y: 400 }, to: { x: 732, y: 300 } });
    expect(geometry.segments[1]).toEqual({ from: { x: 732, y: 300 }, to: { x: 792, y: 400 } });
    expect(geometry.segments[6]).toEqual({ from: { x: 1032, y: 400 }, to: { x: 1092, y: 300 } });
  });

  it('is continuous: each leg starts where the previous one ended', () => {
    for (let i = 1; i < geometry.segments.length; i++) {
      expect(geometry.segments[i].from).toEqual(geometry.segments[i - 1].to);
    }
  });

  it('visits every anchor, in order', () => {
    expect(geometry.points).toEqual(ZIGZAG.map((a) => projectAnchor(a, price, time)));
    expect(geometry.segments[0].from).toEqual(geometry.points[0]);
    expect(geometry.segments[geometry.segments.length - 1].to).toEqual(
      geometry.points[geometry.points.length - 1],
    );
  });

  it('is OPEN — nothing joins the last anchor back to the first', () => {
    const first = geometry.points[0];
    const last = geometry.points[geometry.points.length - 1];
    const closing = geometry.segments.some(
      (s) =>
        (s.from.x === last.x && s.from.y === last.y && s.to.x === first.x && s.to.y === first.y) ||
        (s.from.x === first.x && s.from.y === first.y && s.to.x === last.x && s.to.y === last.y),
    );

    expect(closing).toBe(false);
  });

  it('carries no box, so it cannot be selected by its bounding rectangle', () => {
    expect(geometry.box).toBeNull();
  });

  it('re-derives every leg when the view zooms', () => {
    const drawing = makeDrawing('polyline', ZIGZAG);
    const zoomed = buildGeometry(drawing, price, zoomedTime, PLOT);

    // 40px per bar, five bars apart: 200px legs instead of 60px.
    expect(zoomed.segments[0]).toEqual({ from: { x: 200, y: 400 }, to: { x: 400, y: 300 } });
    expect(zoomed.segments).toHaveLength(7);
    expect(drawing.anchors).toEqual(ZIGZAG);
  });
});

describe('polyline hit testing', () => {
  it('hits a click on the first leg', () => {
    expect(hitTest({ x: 702, y: 350 }, [geometry], 6)).toHaveLength(1);
  });

  it('hits a click on a middle leg', () => {
    expect(hitTest({ x: 882, y: 350 }, [geometry], 6)).toHaveLength(1);
  });

  it('misses a click off the path', () => {
    // 50px above every vertex, so no leg comes near it — and no closing chord either.
    expect(hitTest({ x: 882, y: 250 }, [geometry], 6)).toHaveLength(0);
  });

  it('reports which vertex was grabbed, for dragging', () => {
    expect(hitTest({ x: 912, y: 400 }, [geometry], 6)[0].anchorIndex).toBe(4);
  });
});

describe('polyline preview', () => {
  it('draws the placed legs and rubber-bands the next one', () => {
    const placed = ZIGZAG.slice(0, 3);
    const preview = buildPreviewGeometry('polyline', placed, ZIGZAG[3], price, time, PLOT);

    expect(preview.complete).toBe(false);
    // Points are the placed anchors plus the cursor — no padding copies.
    expect(preview.points).toHaveLength(4);
    expect(preview.segments[0]).toEqual({ from: { x: 672, y: 400 }, to: { x: 732, y: 300 } });
    expect(preview.segments[2]).toEqual({ from: { x: 792, y: 400 }, to: { x: 852, y: 300 } });
    for (const segment of preview.segments) {
      expect(Number.isFinite(segment.from.x + segment.to.y)).toBe(true);
    }
  });

  it('moves the free leg with the cursor and leaves the placed ones alone', () => {
    const placed = ZIGZAG.slice(0, 3);
    const first = buildPreviewGeometry('polyline', placed, ZIGZAG[3], price, time, PLOT);
    const second = buildPreviewGeometry(
      'polyline',
      placed,
      { barIndex: 25, price: 90 },
      price,
      time,
      PLOT,
    );

    expect(second.segments[0]).toEqual(first.segments[0]);
    expect(second.segments[2].to).toEqual({ x: 912, y: 500 });
    expect(second.segments[2].to).not.toEqual(first.segments[2].to);
  });
});
