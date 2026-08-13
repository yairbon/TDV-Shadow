/**
 * parallel-channel — base line through anchors 0→1, a parallel copy through anchor 2, and
 * the two edges that close the band.
 *
 * Two properties define the tool and both are asserted on a LOG scale as well as a linear
 * one, because that is the only place where a wrong implementation is visible:
 *   the copy passes exactly through the projected third anchor, and
 *   the copy's pixel direction vector equals the base's, exactly.
 */

import { describe, expect, it } from 'vitest';

import { buildGeometry, buildPreviewGeometry, projectAnchor } from '../../../src/drawings/geometry.js';
import { hitTest } from '../../../src/drawings/hitTest.js';
import type { Anchor } from '../../../src/drawings/types.js';
import { A, B, PLOT, logPrice, makeDrawing, price, time, zoomedTime } from './projectors.js';

/** Below the base line, so the channel reads as a down-shifted copy. -> (852, 500) */
const T: Anchor = { barIndex: 20, price: 90 };

const channel = makeDrawing('parallel-channel', [A, B, T]);
const geometry = buildGeometry(channel, price, time, PLOT);

describe('parallel-channel geometry', () => {
  it('draws the base line through the first two anchors', () => {
    expect(geometry.complete).toBe(true);
    expect(geometry.segments[0]).toEqual({ from: { x: 672, y: 400 }, to: { x: 852, y: 200 } });
  });

  it('draws the copy from the third anchor, translated by the base vector', () => {
    // (852,500) + (180,-200) = (1032,300).
    expect(geometry.segments[1]).toEqual({ from: { x: 852, y: 500 }, to: { x: 1032, y: 300 } });
  });

  it('closes the band with the two edges', () => {
    expect(geometry.segments[2]).toEqual({ from: { x: 672, y: 400 }, to: { x: 852, y: 500 } });
    expect(geometry.segments[3]).toEqual({ from: { x: 852, y: 200 }, to: { x: 1032, y: 300 } });
    expect(geometry.segments).toHaveLength(4);
  });

  it('keeps all three anchors grabbable', () => {
    expect(geometry.points).toEqual([
      { x: 672, y: 400 },
      { x: 852, y: 200 },
      { x: 852, y: 500 },
    ]);
  });

  it('is exactly parallel: identical direction vectors, not merely similar', () => {
    const [baseLine, copy] = geometry.segments;
    expect(copy.to.x - copy.from.x).toBe(baseLine.to.x - baseLine.from.x);
    expect(copy.to.y - copy.from.y).toBe(baseLine.to.y - baseLine.from.y);
  });

  it('starts the copy ON the third anchor', () => {
    expect(geometry.segments[1].from).toEqual(projectAnchor(T, price, time));
  });
});

describe('parallel-channel on a LOG scale', () => {
  const logged = buildGeometry(channel, logPrice, time, PLOT);

  it('still passes exactly through the third anchor', () => {
    // The reason the copy is translated in pixels: a constant PRICE offset would put this
    // line off the very handle the user dragged it to as soon as the scale went log.
    expect(logged.segments[1].from).toEqual(projectAnchor(T, logPrice, time));
  });

  it('is still exactly parallel in pixels', () => {
    const [baseLine, copy] = logged.segments;
    expect(copy.to.x - copy.from.x).toBeCloseTo(baseLine.to.x - baseLine.from.x, 12);
    expect(copy.to.y - copy.from.y).toBeCloseTo(baseLine.to.y - baseLine.from.y, 12);
  });

  it('therefore spans a different PRICE gap at each end of the band — by design', () => {
    // The trade-off made explicit. On a linear scale the two gaps are equal; on a log one
    // they cannot be, and the tool keeps the picture parallel rather than the prices equal.
    const linearGaps = [
      price.price(geometry.segments[0].from.y) - price.price(geometry.segments[1].from.y),
      price.price(geometry.segments[0].to.y) - price.price(geometry.segments[1].to.y),
    ];
    expect(linearGaps[0]).toBeCloseTo(linearGaps[1], 9);

    const logGaps = [
      logPrice.price(logged.segments[0].from.y) - logPrice.price(logged.segments[1].from.y),
      logPrice.price(logged.segments[0].to.y) - logPrice.price(logged.segments[1].to.y),
    ];
    expect(Math.abs(logGaps[0] - logGaps[1])).toBeGreaterThan(1);
  });
});

describe('parallel-channel and the anchor rule', () => {
  it('re-derives every pixel when the view zooms, and stays parallel', () => {
    const after = buildGeometry(channel, price, zoomedTime, PLOT);

    // 40px/bar instead of 12: bar 5 -> 200, bar 20 -> 800.
    expect(after.segments[0]).toEqual({ from: { x: 200, y: 400 }, to: { x: 800, y: 200 } });
    expect(after.segments[1]).toEqual({ from: { x: 800, y: 500 }, to: { x: 1400, y: 300 } });
    expect(after.segments[1].to.x - after.segments[1].from.x).toBe(
      after.segments[0].to.x - after.segments[0].from.x,
    );
    expect(channel.anchors).toEqual([A, B, T]);
  });

  it('survives a degenerate base with all coordinates finite', () => {
    const flat = buildGeometry(makeDrawing('parallel-channel', [A, A, T]), price, time, PLOT);
    for (const segment of flat.segments) {
      expect(Number.isFinite(segment.from.x + segment.from.y)).toBe(true);
      expect(Number.isFinite(segment.to.x + segment.to.y)).toBe(true);
    }
    expect(flat.segments[1]).toEqual({ from: { x: 852, y: 500 }, to: { x: 852, y: 500 } });
  });
});

describe('parallel-channel hit testing', () => {
  it('hits a click on the base line', () => {
    expect(hitTest({ x: 762, y: 300 }, [geometry], 6)).toHaveLength(1);
  });

  it('hits a click on the parallel copy', () => {
    expect(hitTest({ x: 942, y: 400 }, [geometry], 6)).toHaveLength(1);
  });

  it('hits a click on a closing edge', () => {
    expect(hitTest({ x: 762, y: 450 }, [geometry], 6)).toHaveLength(1);
  });

  it('misses a click in the middle of the band', () => {
    // The band is an outline, not a filled region: ~100px from either line, so a click in
    // the empty middle must not select the channel.
    expect(hitTest({ x: 852, y: 350 }, [geometry], 6)).toHaveLength(0);
  });

  it('misses a click outside the band entirely', () => {
    expect(hitTest({ x: 300, y: 100 }, [geometry], 6)).toHaveLength(0);
  });

  it('reports the third anchor when it is grabbed', () => {
    expect(hitTest({ x: 852, y: 500 }, [geometry], 6)[0].anchorIndex).toBe(2);
  });
});

describe('parallel-channel preview', () => {
  it('previews a full band from two placed anchors', () => {
    const preview = buildPreviewGeometry('parallel-channel', [A, B], T, price, time, PLOT);

    expect(preview.complete).toBe(false);
    expect(preview.segments).toHaveLength(4);
    expect(preview.segments[0]).toEqual({ from: { x: 672, y: 400 }, to: { x: 852, y: 200 } });
    expect(preview.segments[1]).toEqual({ from: { x: 852, y: 500 }, to: { x: 1032, y: 300 } });
    expect(preview.points).toHaveLength(3);
  });

  it('previews from one placed anchor without padding copies reaching the handles', () => {
    const preview = buildPreviewGeometry('parallel-channel', [A], B, price, time, PLOT);

    expect(preview.points).toEqual([
      { x: 672, y: 400 },
      { x: 852, y: 200 },
    ]);
    for (const segment of preview.segments) {
      expect(Number.isFinite(segment.to.x + segment.to.y)).toBe(true);
    }
  });
});
