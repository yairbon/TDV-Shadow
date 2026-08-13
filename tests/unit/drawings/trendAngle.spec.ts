/**
 * trend-angle — a trend line that reports the angle it subtends ON SCREEN.
 *
 * This is the one tool whose headline number is a pixel property, so the spec is built to
 * fail if it ever stops being one: the very same anchors must read 45° at 12px/bar, 16.7°
 * at 40px/bar and something else again on a log scale. A data-space `atan2(Δprice, Δbar)`
 * would print one constant figure through all three and pass nothing here.
 */

import { describe, expect, it } from 'vitest';

import { buildGeometry, buildPreviewGeometry } from '../../../src/drawings/geometry.js';
import { hitTest } from '../../../src/drawings/hitTest.js';
import type { Anchor } from '../../../src/drawings/types.js';
import { PLOT, logPrice, makeDrawing, price, time, zoomedTime } from './projectors.js';

/** (672,400). */
const ORIGIN: Anchor = { barIndex: 5, price: 100 };
/** (852,220): 180px right, 180px up — exactly 45° at 12px per bar. */
const UP_45: Anchor = { barIndex: 20, price: 118 };
/** (852,580): 180px right, 180px down. */
const DOWN_45: Anchor = { barIndex: 20, price: 82 };

const angle = (from: Anchor, to: Anchor, timeScale = time, priceScale = price) =>
  buildGeometry(makeDrawing('trend-angle', [from, to]), priceScale, timeScale, PLOT);

describe('trend-angle geometry', () => {
  it('draws the trend line between the anchors', () => {
    const geometry = angle(ORIGIN, UP_45);

    expect(geometry.complete).toBe(true);
    expect(geometry.segments).toEqual([{ from: { x: 672, y: 400 }, to: { x: 852, y: 220 } }]);
    expect(geometry.points).toEqual([
      { x: 672, y: 400 },
      { x: 852, y: 220 },
    ]);
  });

  it('reads 45° when the pixel runs are equal', () => {
    expect(angle(ORIGIN, UP_45).labels).toEqual([{ x: 852, y: 220, text: '45.0°' }]);
  });

  it('signs a falling line negative, the way a person would say it', () => {
    expect(angle(ORIGIN, DOWN_45).labels[0].text).toBe('-45.0°');
  });

  it('reads 0° flat, 90° straight up and 180° back to the left', () => {
    expect(angle(ORIGIN, { barIndex: 20, price: 100 }).labels[0].text).toBe('0.0°');
    expect(angle(ORIGIN, { barIndex: 5, price: 120 }).labels[0].text).toBe('90.0°');
    expect(angle({ barIndex: 20, price: 100 }, ORIGIN).labels[0].text).toBe('180.0°');
  });

  it('puts the readout at the far end of the line', () => {
    const geometry = angle(ORIGIN, UP_45);
    expect(geometry.labels[0].x).toBe(geometry.segments[0].to.x);
    expect(geometry.labels[0].y).toBe(geometry.segments[0].to.y);
  });

  it('reports 0° for a zero-length line rather than NaN', () => {
    expect(angle(ORIGIN, ORIGIN).labels[0].text).toBe('0.0°');
  });
});

describe('trend-angle is a PIXEL measurement — the whole point of the tool', () => {
  const drawing = makeDrawing('trend-angle', [ORIGIN, UP_45]);

  it('reports a different angle for the same anchors at a different bar spacing', () => {
    const at12 = buildGeometry(drawing, price, time, PLOT);
    const at40 = buildGeometry(drawing, price, zoomedTime, PLOT);

    // 180px right / 180px up -> 45°. The same 15 bars at 40px each are 600px right for the
    // same 180px up -> 16.7°.
    expect(at12.labels[0].text).toBe('45.0°');
    expect(at40.labels[0].text).toBe('16.7°');
    expect(drawing.anchors).toEqual([ORIGIN, UP_45]);
  });

  it('reports a different angle again on a log scale', () => {
    const linear = buildGeometry(drawing, price, time, PLOT);
    const logged = buildGeometry(drawing, logPrice, time, PLOT);
    const degrees = (text: string) => Number.parseFloat(text);

    expect(degrees(logged.labels[0].text)).not.toBeCloseTo(degrees(linear.labels[0].text), 1);
    // …and it is still the arctangent of what is actually on screen.
    const dy = logged.segments[0].from.y - logged.segments[0].to.y;
    const dx = logged.segments[0].to.x - logged.segments[0].from.x;
    expect(degrees(logged.labels[0].text)).toBeCloseTo((Math.atan2(dy, dx) * 180) / Math.PI, 1);
  });

  it('is not the data-space slope wearing a degree sign', () => {
    // atan2(Δprice, Δbar) for these anchors is atan2(18, 15) ≈ 50.2°, and would be the same
    // number at every zoom. Neither view reports it.
    const dataSpace = (Math.atan2(18, 15) * 180) / Math.PI;
    expect(dataSpace).toBeCloseTo(50.2, 1);

    for (const scale of [time, zoomedTime]) {
      const reported = Number.parseFloat(buildGeometry(drawing, price, scale, PLOT).labels[0].text);
      expect(Math.abs(reported - dataSpace)).toBeGreaterThan(1);
    }
  });
});

describe('trend-angle hit testing', () => {
  const geometry = angle(ORIGIN, UP_45);

  it('hits a click on the line', () => {
    expect(hitTest({ x: 762, y: 310 }, [geometry], 6)).toHaveLength(1);
  });

  it('misses a click beside it', () => {
    expect(hitTest({ x: 762, y: 330 }, [geometry], 6)).toHaveLength(0);
  });

  it('misses a click past the end — it is a segment, not a ray', () => {
    expect(hitTest({ x: 1000, y: 80 }, [geometry], 6)).toHaveLength(0);
  });
});

describe('trend-angle preview', () => {
  it('reads out the angle live while the line is being dragged', () => {
    const shallow = buildPreviewGeometry(
      'trend-angle',
      [ORIGIN],
      { barIndex: 20, price: 109 },
      price,
      time,
      PLOT,
    );
    const steep = buildPreviewGeometry('trend-angle', [ORIGIN], UP_45, price, time, PLOT);

    expect(shallow.complete).toBe(false);
    // 90px up over 180px right.
    expect(shallow.labels[0].text).toBe('26.6°');
    expect(steep.labels[0].text).toBe('45.0°');
  });
});
