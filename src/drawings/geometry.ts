/**
 * Drawing geometry — data space to pixels, recomputed every frame.
 *
 * THE ANCHOR RULE (types.ts) in practice: nothing here stores a pixel. Every function
 * takes narrow scale interfaces and derives pixels on the spot, which is what makes a
 * drawing survive pan, zoom, resize and a log-scale switch. The scales are narrowed to
 * four methods so this module is testable with fakes and works unchanged in log mode —
 * it never needs to know which transform is active.
 *
 * Fibonacci levels are computed in PRICE space (`p0 + (p1 - p0) * ratio`) and only then
 * projected. Computing them by interpolating PIXELS would look identical on a linear
 * scale and be wrong on a log one, where equal price steps are not equal pixel steps.
 */

import {
  FIB_EXTENSION_LEVELS,
  FIB_RETRACEMENT_LEVELS,
  GANN_RATIOS,
  ELLIOTT_CORRECTION_LABELS,
  ELLIOTT_IMPULSE_LABELS,
  type Anchor,
  type Drawing,
} from './types.js';
import { DEFAULT_STYLE, TOOL_DEFINITIONS } from './tools.js';

export interface PriceProjector {
  y(price: number): number;
  price(y: number): number;
}

export interface TimeProjector {
  x(barIndex: number): number;
  indexAt(x: number): number;
}

export interface PlotBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Segment {
  readonly from: Point;
  readonly to: Point;
}

/** A labelled horizontal level (fib ratios, position zones). */
export interface Level {
  readonly price: number;
  readonly y: number;
  readonly label: string;
  /**
   * Left end of the level's own run, in CSS px — where its label belongs.
   *
   * The renderer used to put every level label at `plot.left + 6` no matter where the
   * drawing was, so a fib placed in the middle of the chart labelled itself over on the
   * far left, on top of the legend and pointing at nothing.
   */
  readonly x: number;
}

export interface DrawingGeometry {
  readonly id: string;
  readonly kind: Drawing['kind'];
  /**
   * Carried through from the drawing so the renderer can honour it. Before this the
   * whole `DrawingStyle` block — colour, width, dash, opacity, labels — was stored,
   * serialised and never read by anything that paints.
   */
  readonly style: Drawing['style'];
  /** False when fewer anchors than the tool needs have been placed. */
  readonly complete: boolean;
  readonly segments: readonly Segment[];
  readonly levels: readonly Level[];
  readonly points: readonly Point[];
  readonly labels: readonly (Point & { readonly text: string })[];
  /** Axis-aligned box for rectangle-like tools. */
  readonly box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } | null;
}

export function projectAnchor(anchor: Anchor, price: PriceProjector, time: TimeProjector): Point {
  return { x: time.x(anchor.barIndex), y: price.y(anchor.price) };
}

export function unprojectPoint(point: Point, price: PriceProjector, time: TimeProjector): Anchor {
  return { barIndex: time.indexAt(point.x), price: price.price(point.y) };
}

/** Extends the ray a->b to the plot edge, preserving direction. */
function extendToEdge(a: Point, b: Point, plot: PlotBox): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return b;

  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  // Largest t >= 1 that keeps the point inside the plot box.
  let t = Number.POSITIVE_INFINITY;
  if (dx > 0) t = Math.min(t, (right - a.x) / dx);
  if (dx < 0) t = Math.min(t, (plot.left - a.x) / dx);
  if (dy > 0) t = Math.min(t, (bottom - a.y) / dy);
  if (dy < 0) t = Math.min(t, (plot.top - a.y) / dy);
  if (!Number.isFinite(t)) return b;
  return { x: a.x + dx * t, y: a.y + dy * t };
}

const empty = (drawing: Drawing, complete: boolean): DrawingGeometry => ({
  id: drawing.id,
  kind: drawing.kind,
  style: drawing.style,
  complete,
  segments: [],
  levels: [],
  points: [],
  labels: [],
  box: null,
});

/** Formats a fib ratio for its label: 0.618 -> "0.618", 1 -> "1". */
function ratioLabel(ratio: number): string {
  return Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(3).replace(/0+$/, '');
}

export function buildGeometry(
  drawing: Drawing,
  price: PriceProjector,
  time: TimeProjector,
  plot: PlotBox,
): DrawingGeometry {
  const needed = TOOL_DEFINITIONS[drawing.kind].anchorCount;
  if (drawing.anchors.length < needed) return empty(drawing, false);

  const points = drawing.anchors.map((a) => projectAnchor(a, price, time));
  const base = { id: drawing.id, kind: drawing.kind, style: drawing.style, complete: true } as const;
  const p0 = points[0];
  const p1 = points.length > 1 ? points[1] : p0;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;

  switch (drawing.kind) {
    case 'trendline':
    case 'arrow':
      return { ...base, segments: [{ from: p0, to: p1 }], levels: [], points, labels: [], box: null };

    case 'ray':
      return {
        ...base,
        segments: [{ from: p0, to: extendToEdge(p0, p1, plot) }],
        levels: [],
        points,
        labels: [],
        box: null,
      };

    case 'extended-line':
      return {
        ...base,
        segments: [{ from: extendToEdge(p1, p0, plot), to: extendToEdge(p0, p1, plot) }],
        levels: [],
        points,
        labels: [],
        box: null,
      };

    case 'horizontal-line':
      return {
        ...base,
        segments: [{ from: { x: plot.left, y: p0.y }, to: { x: right, y: p0.y } }],
        // A horizontal line spans the whole plot, so its own left edge IS the plot's.
        levels: [
          {
            price: drawing.anchors[0].price,
            y: p0.y,
            label: drawing.anchors[0].price.toFixed(2),
            x: plot.left,
          },
        ],
        points,
        labels: [],
        box: null,
      };

    case 'horizontal-ray':
      return {
        ...base,
        // Rightwards only, from the anchor — not `extendToEdge`, which would need a second
        // point to take a direction from and would happily run left for a leftward one.
        segments: [{ from: p0, to: { x: right, y: p0.y } }],
        // The run starts at the ANCHOR, not at the plot's left edge. Unlike
        // `horizontal-line`, this level occupies only the plot to the right of its anchor,
        // and its label belongs at the start of its own run (see `Level.x`).
        levels: [
          {
            price: drawing.anchors[0].price,
            y: p0.y,
            label: drawing.anchors[0].price.toFixed(2),
            x: p0.x,
          },
        ],
        points,
        labels: [],
        box: null,
      };

    case 'vertical-line':
      return {
        ...base,
        segments: [{ from: { x: p0.x, y: plot.top }, to: { x: p0.x, y: bottom } }],
        levels: [],
        points,
        labels: [],
        box: null,
      };

    case 'rectangle':
    case 'ellipse':
    case 'gann-box':
      return {
        ...base,
        segments: [],
        levels: [],
        points,
        labels: [],
        box: {
          x0: Math.min(p0.x, p1.x),
          y0: Math.min(p0.y, p1.y),
          x1: Math.max(p0.x, p1.x),
          y1: Math.max(p0.y, p1.y),
        },
      };

    case 'fib-retracement':
    case 'fib-extension': {
      const ratios =
        drawing.kind === 'fib-retracement' ? FIB_RETRACEMENT_LEVELS : FIB_EXTENSION_LEVELS;
      const priceA = drawing.anchors[0].price;
      const priceB = drawing.anchors[1].price;
      const x0 = Math.min(p0.x, p1.x);
      const x1 = Math.max(p0.x, p1.x);
      const levels: Level[] = ratios.map((ratio) => {
        // Price space, always. Interpolating pixels here would be wrong on a log scale.
        const levelPrice = priceA + (priceB - priceA) * ratio;
        return {
          price: levelPrice,
          y: price.y(levelPrice),
          label: `${ratioLabel(ratio)} (${levelPrice.toFixed(2)})`,
          x: x0,
        };
      });
      return {
        ...base,
        segments: levels.map((l) => ({ from: { x: x0, y: l.y }, to: { x: x1, y: l.y } })),
        levels,
        points,
        labels: [],
        box: null,
      };
    }

    case 'fib-time-zones': {
      const spanBars = drawing.anchors[1].barIndex - drawing.anchors[0].barIndex;
      const sequence = [1, 2, 3, 5, 8, 13, 21, 34];
      const segments: Segment[] = sequence.map((n) => {
        const x = time.x(drawing.anchors[0].barIndex + spanBars * n);
        return { from: { x, y: plot.top }, to: { x, y: bottom } };
      });
      return { ...base, segments, levels: [], points, labels: [], box: null };
    }

    case 'fib-fan':
    case 'gann-fan': {
      const ratios = drawing.kind === 'gann-fan' ? GANN_RATIOS : FIB_RETRACEMENT_LEVELS;
      const priceA = drawing.anchors[0].price;
      const priceB = drawing.anchors[1].price;
      const segments: Segment[] = ratios
        .filter((r) => r > 0)
        .map((ratio) => {
          const target = priceA + (priceB - priceA) * ratio;
          const to = { x: p1.x, y: price.y(target) };
          return { from: p0, to: extendToEdge(p0, to, plot) };
        });
      return { ...base, segments, levels: [], points, labels: [], box: null };
    }

    case 'pitchfork': {
      const p2 = points[2];
      // Median line runs from the first anchor through the midpoint of the other two.
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const dx = mid.x - p0.x;
      const dy = mid.y - p0.y;
      const parallel = (from: Point): Segment => ({
        from,
        to: extendToEdge(from, { x: from.x + dx, y: from.y + dy }, plot),
      });
      return {
        ...base,
        segments: [
          { from: p0, to: extendToEdge(p0, mid, plot) },
          parallel(p1),
          parallel(p2),
        ],
        levels: [],
        points,
        labels: [],
        box: null,
      };
    }

    case 'elliott-impulse':
    case 'elliott-correction': {
      const names =
        drawing.kind === 'elliott-impulse' ? ELLIOTT_IMPULSE_LABELS : ELLIOTT_CORRECTION_LABELS;
      const segments: Segment[] = [];
      for (let i = 1; i < points.length; i++) segments.push({ from: points[i - 1], to: points[i] });
      const labels = points.map((point, i) => ({
        ...point,
        text: names[Math.min(i, names.length - 1)],
      }));
      return { ...base, segments, levels: [], points, labels, box: null };
    }

    case 'long-position':
    case 'short-position': {
      const entry = drawing.anchors[0];
      const target = drawing.anchors[1];
      const stop = drawing.anchors[2];
      const reward = Math.abs(target.price - entry.price);
      const risk = Math.abs(entry.price - stop.price);
      const ratio = risk === 0 ? Number.POSITIVE_INFINITY : reward / risk;
      const x0 = Math.min(p0.x, points[1].x);
      const x1 = Math.max(p0.x, points[1].x);
      const levels: Level[] = [
        { price: entry.price, y: price.y(entry.price), label: `Entry ${entry.price.toFixed(2)}`, x: x0 },
        {
          price: target.price,
          y: price.y(target.price),
          label: `Target ${target.price.toFixed(2)}`,
          x: x0,
        },
        { price: stop.price, y: price.y(stop.price), label: `Stop ${stop.price.toFixed(2)}`, x: x0 },
      ];
      return {
        ...base,
        segments: levels.map((l) => ({ from: { x: x0, y: l.y }, to: { x: x1, y: l.y } })),
        levels,
        points,
        labels: [{ x: x1, y: price.y(entry.price), text: `R:R ${ratio.toFixed(2)}` }],
        box: {
          x0,
          y0: Math.min(price.y(target.price), price.y(stop.price)),
          x1,
          y1: Math.max(price.y(target.price), price.y(stop.price)),
        },
      };
    }

    case 'text-note':
      return {
        ...base,
        segments: [],
        levels: [],
        points,
        labels: [{ ...p0, text: String(drawing.params['text'] ?? '') }],
        box: null,
      };
  }
}

/**
 * Id every in-progress preview carries.
 *
 * Deliberately not a store id: nothing in the store can ever collide with it, so a
 * preview geometry can never be selected, hit-tested, undone or saved by id.
 */
export const PREVIEW_ID = '__preview__';

/**
 * The shape as it WOULD be if the user clicked at `cursor` right now.
 *
 * Placing a two-anchor drawing used to give zero feedback: the first anchor lived in a
 * `pending` array the renderer never saw, and `buildGeometry` answers a short anchor list
 * with `empty()` — no segments, no points, nothing to paint. This is the other path: the
 * anchor list is treated as `[...placed, cursor]`, padded with repeats of `cursor` when the
 * tool wants more, so a half-placed pitchfork previews as a degenerate-but-valid shape
 * instead of drawing nothing.
 *
 * The per-kind maths is NOT duplicated here — this delegates to `buildGeometry`, so a ray
 * still extends to the plot edge and a fib still computes its levels in price space while
 * being dragged out. Two things are then overridden:
 *
 *   `complete: false` — always, so a preview can never be mistaken for a real drawing.
 *   `points` — exactly `[...placed, cursor]`, WITHOUT the padding repeats. The renderer's
 *   contract is that the last point is the floating cursor anchor and everything before it
 *   is pinned; padding copies would otherwise pile pinned-looking handles on the cursor.
 *   With `placed` empty that leaves a single point — the armed-but-unclicked marker.
 */
export function buildPreviewGeometry(
  kind: Drawing['kind'],
  placed: readonly Anchor[],
  cursor: Anchor,
  price: PriceProjector,
  time: TimeProjector,
  plot: PlotBox,
): DrawingGeometry {
  const visible: readonly Anchor[] = [...placed, cursor];
  const anchors = [...visible];
  const needed = TOOL_DEFINITIONS[kind].anchorCount;
  while (anchors.length < needed) anchors.push(cursor);

  const provisional: Drawing = {
    id: PREVIEW_ID,
    kind,
    anchors,
    style: DEFAULT_STYLE,
    locked: false,
    visible: true,
    params: TOOL_DEFINITIONS[kind].defaults,
    magnetTargets: [],
  };

  return {
    ...buildGeometry(provisional, price, time, plot),
    complete: false,
    points: visible.map((anchor) => projectAnchor(anchor, price, time)),
  };
}

const QUARTER_TURN = Math.PI / 4;
const DIAGONAL = Math.SQRT1_2;

/**
 * Unit vectors for the eight 45° directions, indexed by `round(angle / 45°)`.
 *
 * A table rather than `cos`/`sin` of the snapped angle: `Math.cos(Math.PI / 2)` is 6.1e-17,
 * not 0, so a vertical constraint computed trigonometrically drifts sideways.
 */
const OCTANTS: readonly Point[] = Object.freeze([
  { x: 1, y: 0 },
  { x: DIAGONAL, y: DIAGONAL },
  { x: 0, y: 1 },
  { x: -DIAGONAL, y: DIAGONAL },
  { x: -1, y: 0 },
  { x: -DIAGONAL, y: -DIAGONAL },
  { x: 0, y: -1 },
  { x: DIAGONAL, y: -DIAGONAL },
]);

/**
 * Snaps the `from -> to` vector to the nearest 45°, preserving its length.
 *
 * PIXEL space, and that is the whole point: an angle is a property of what the user sees.
 * Snapping the equivalent data-space vector would give a different visual angle at every
 * zoom level and every price range, so the "45° line" would stop looking like 45° the
 * moment anyone scrolled.
 */
export function constrainToAngle(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return to;

  // atan2 is (-pi, pi], so the rounded octant is -4..4; the double modulo folds -4 onto 4
  // and every negative index onto its positive equivalent.
  const octant = ((Math.round(Math.atan2(dy, dx) / QUARTER_TURN) % 8) + 8) % 8;
  const direction = OCTANTS[octant];
  return { x: from.x + direction.x * length, y: from.y + direction.y * length };
}
