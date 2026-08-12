/**
 * date-range — two anchors, a box, and the span between them as a bar count and elapsed
 * time.
 *
 * The count is `|Δ barIndex|`, so the assertion that matters is that changing the VIEW
 * (bar spacing) cannot change the text: an implementation that counted pixels and divided
 * by the spacing would look right at 12px/bar and drift at 40.
 *
 * Elapsed time needs a millisecond-per-bar figure that `buildGeometry` has no way to know,
 * so it arrives as the `barMs` param; 0 means "not supplied" and suppresses the duration.
 */

import { describe, expect, it } from 'vitest';

import { buildGeometry, buildPreviewGeometry } from '../../../src/drawings/geometry.js';
import { hitTest } from '../../../src/drawings/hitTest.js';
import { TIMEFRAME_MS } from '../../../src/data/types.js';
import type { Anchor, Drawing } from '../../../src/drawings/types.js';
import { A, B, PLOT, makeDrawing, price, time, zoomedTime } from './projectors.js';

const span = (from: Anchor, to: Anchor, params: Drawing['params'] = {}) =>
  buildGeometry(makeDrawing('date-range', [from, to], params), price, time, PLOT);

describe('date-range geometry', () => {
  it('boxes the two anchors', () => {
    const geometry = span(A, B);

    expect(geometry.complete).toBe(true);
    expect(geometry.box).toEqual({ x0: 672, y0: 200, x1: 852, y1: 400 });
    expect(geometry.segments).toEqual([]);
  });

  it('counts the bars between the anchors', () => {
    // Bars 5 -> 20.
    expect(span(A, B).labels).toEqual([{ x: 762, y: 300, text: '15 bars' }]);
  });

  it('counts the same span dragged right-to-left', () => {
    expect(span(B, A).labels[0].text).toBe('15 bars');
  });

  it('says "1 bar", not "1 bars"', () => {
    expect(span(A, { barIndex: 6, price: 120 }).labels[0].text).toBe('1 bar');
  });

  it('rounds a fractional placement to whole bars', () => {
    expect(span({ barIndex: 5.2, price: 100 }, { barIndex: 20.4, price: 120 }).labels[0].text).toBe(
      '15 bars',
    );
    expect(span({ barIndex: 5.2, price: 100 }, { barIndex: 20.9, price: 120 }).labels[0].text).toBe(
      '16 bars',
    );
  });

  it('adds elapsed time once the timeframe is supplied', () => {
    expect(span(A, B, { barMs: TIMEFRAME_MS['1m'] }).labels[0].text).toBe('15 bars, 15m');
    expect(span(A, B, { barMs: TIMEFRAME_MS['1h'] }).labels[0].text).toBe('15 bars, 15h');
    expect(span(A, B, { barMs: TIMEFRAME_MS['1d'] }).labels[0].text).toBe('15 bars, 15d');
  });

  it('rolls minutes up into hours and days', () => {
    // 15 bars of 15m = 225 minutes.
    expect(span(A, B, { barMs: TIMEFRAME_MS['15m'] }).labels[0].text).toBe('15 bars, 3h 45m');
    // 15 bars of 4h = 60 hours = 2 days 12 hours, and no stray "0m".
    expect(span(A, B, { barMs: TIMEFRAME_MS['4h'] }).labels[0].text).toBe('15 bars, 2d 12h');
  });

  it('omits the duration when the timeframe is not supplied, rather than inventing one', () => {
    expect(span(A, B, {}).labels[0].text).toBe('15 bars');
    expect(span(A, B, { barMs: 0 }).labels[0].text).toBe('15 bars');
  });

  it('ignores a barMs of the wrong type instead of printing NaN', () => {
    expect(span(A, B, { barMs: 'hourly' }).labels[0].text).toBe('15 bars');
  });

  it('takes a real number only — a numeric STRING is not a timeframe', () => {
    // `params` is `number | string | boolean`, so this is a value the store will accept and
    // a JSON round-trip can produce. Coercing it would report a duration the caller never
    // set; the guard in `numberParam` is what stops that.
    expect(span(A, B, { barMs: '60000' }).labels[0].text).toBe('15 bars');
    expect(span(A, B, { barMs: true }).labels[0].text).toBe('15 bars');
  });

  it('places the annotation at the centre of the box', () => {
    const geometry = span(A, B);
    const box = geometry.box;
    if (box === null) throw new Error('date-range must have a box');
    expect(geometry.labels[0].x).toBe((box.x0 + box.x1) / 2);
    expect(geometry.labels[0].y).toBe((box.y0 + box.y1) / 2);
  });
});

describe('date-range and the anchor rule', () => {
  it('counts bars, not pixels: the text survives a zoom that moves every corner', () => {
    const drawing = makeDrawing('date-range', [A, B], { barMs: TIMEFRAME_MS['1h'] });
    const before = buildGeometry(drawing, price, time, PLOT);
    const after = buildGeometry(drawing, price, zoomedTime, PLOT);

    expect(after.box).toEqual({ x0: 200, y0: 200, x1: 800, y1: 400 });
    expect(after.box).not.toEqual(before.box);
    expect(after.labels[0].text).toBe('15 bars, 15h');
    expect(after.labels[0].text).toBe(before.labels[0].text);
    expect(drawing.anchors).toEqual([A, B]);
  });
});

describe('date-range hit testing', () => {
  const geometry = span(A, B);

  it('hits a click on the box border', () => {
    expect(hitTest({ x: 672, y: 300 }, [geometry], 6)).toHaveLength(1);
  });

  it('misses a click in the middle of the box', () => {
    expect(hitTest({ x: 762, y: 300 }, [geometry], 6)).toHaveLength(0);
  });
});

describe('date-range preview', () => {
  it('counts live while the second corner is being dragged', () => {
    const short = buildPreviewGeometry(
      'date-range',
      [A],
      { barIndex: 10, price: 120 },
      price,
      time,
      PLOT,
    );
    const long = buildPreviewGeometry('date-range', [A], B, price, time, PLOT);

    expect(short.complete).toBe(false);
    expect(short.labels[0].text).toBe('5 bars');
    expect(long.labels[0].text).toBe('15 bars');
  });
});
