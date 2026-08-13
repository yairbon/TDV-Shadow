/**
 * Shared fakes for the drawing specs: the §2/§3/§5 transforms with ROUND pixel values,
 * so every expected coordinate in a spec can be written out in full rather than being
 * recomputed by the test from the same formula the code uses.
 *
 * Not a `.spec.ts`, so vitest's `tests/**\/*.spec.ts` glob never collects it as a suite.
 */

import type {
  PlotBox,
  PriceProjector,
  TimeProjector,
} from '../../../src/drawings/geometry.js';
import { createDrawingStore } from '../../../src/drawings/store.js';
import type { Anchor, Drawing, DrawingKind } from '../../../src/drawings/types.js';

export const PLOT: PlotBox = { left: 0, top: 0, width: 1200, height: 600 };

/** §2 linear: 60 price units over 600px, so y(140) = 0 and y(80) = 600. */
export const price: PriceProjector = {
  y: (p) => (140 - p) * 10,
  price: (y) => 140 - y / 10,
};

/** §3 log — the case where price-space and pixel-space maths diverge. */
export const logPrice: PriceProjector = {
  y: (p) => (Math.log(260) - Math.log(p)) * (600 / (Math.log(260) - Math.log(50))),
  price: (y) => Math.exp(Math.log(260) - y / (600 / (Math.log(260) - Math.log(50)))),
};

/** §5 time: 12px per bar, bar 49 at the right edge. */
export const time: TimeProjector = {
  x: (i) => 1200 - (49 - i) * 12,
  indexAt: (x) => 49 - (1200 - x) / 12,
};

/** A second §5 map — same anchors, different view, for pan/zoom assertions. */
export const zoomedTime: TimeProjector = {
  x: (i) => 1200 - (30 - i) * 40,
  indexAt: (x) => 30 - (1200 - x) / 40,
};

export const A: Anchor = { barIndex: 5, price: 100 }; // -> (672, 400)
export const B: Anchor = { barIndex: 20, price: 120 }; // -> (852, 200)
export const C: Anchor = { barIndex: 35, price: 90 }; // -> (1032, 500)

/** A stored drawing, so the specs exercise the same freezing the app does. */
export function makeDrawing(
  kind: DrawingKind,
  anchors: readonly Anchor[],
  params: Drawing['params'] = {},
): Drawing {
  return createDrawingStore().add(kind, anchors, { params });
}
