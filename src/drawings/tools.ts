/**
 * Tool catalogue: how many anchors each kind needs and what params it starts with.
 *
 * Split out of `geometry.ts` and `store.ts` because both need it and neither should
 * own it: the store uses `anchorCount` to know when a placement is finished, the
 * geometry uses it to mark a drawing incomplete rather than projecting a missing
 * anchor. `defaults` is the params baseline every new drawing of that kind gets.
 *
 * Nothing here is pixels or scale-dependent — see THE ANCHOR RULE in `types.ts`.
 */

import type { DrawingKind, DrawingStyle, ToolDefinition } from './types.js';

/** Style every new drawing starts from. `colorToken` resolves in the theme, not here. */
export const DEFAULT_STYLE: DrawingStyle = Object.freeze<DrawingStyle>({
  colorToken: 'drawing.primary',
  lineWidth: 1,
  dash: Object.freeze([]),
  opacity: 1,
  showLabels: true,
});

const define = (
  kind: DrawingKind,
  label: string,
  anchorCount: number,
  defaults: ToolDefinition['defaults'] = {},
): ToolDefinition =>
  Object.freeze<ToolDefinition>({ kind, label, anchorCount, defaults: Object.freeze(defaults) });

/**
 * Anchor arities. `fib-extension` takes two anchors, not three: every level is
 * `p0 + (p1 - p0) * ratio` from the same pair the retracement uses, only with
 * `FIB_EXTENSION_LEVELS` substituted for `FIB_RETRACEMENT_LEVELS`.
 *
 * Position tools take three: `[entry, target, stop]`. The entry anchor carries the
 * left edge of the box and the entry price; the target anchor's `barIndex` carries the
 * right edge; the stop anchor's `barIndex` is stored but not used for geometry.
 */
export const TOOL_DEFINITIONS: Readonly<Record<DrawingKind, ToolDefinition>> = Object.freeze({
  trendline: define('trendline', 'Trend Line', 2),
  ray: define('ray', 'Ray', 2),
  'extended-line': define('extended-line', 'Extended Line', 2),
  'horizontal-line': define('horizontal-line', 'Horizontal Line', 1),
  'vertical-line': define('vertical-line', 'Vertical Line', 1),
  rectangle: define('rectangle', 'Rectangle', 2, { filled: true }),
  ellipse: define('ellipse', 'Ellipse', 2, { filled: true }),
  'fib-retracement': define('fib-retracement', 'Fib Retracement', 2, { extendRight: false }),
  'fib-extension': define('fib-extension', 'Fib Extension', 2, { extendRight: false }),
  'fib-fan': define('fib-fan', 'Fib Fan', 2),
  'fib-time-zones': define('fib-time-zones', 'Fib Time Zones', 2),
  'gann-fan': define('gann-fan', 'Gann Fan', 2),
  'gann-box': define('gann-box', 'Gann Box', 2),
  'elliott-impulse': define('elliott-impulse', 'Elliott Impulse Wave', 5, { degree: 'minor' }),
  'elliott-correction': define('elliott-correction', 'Elliott Correction Wave', 3, {
    degree: 'minor',
  }),
  pitchfork: define('pitchfork', 'Pitchfork', 3),
  'long-position': define('long-position', 'Long Position', 3, { precision: 2 }),
  'short-position': define('short-position', 'Short Position', 3, { precision: 2 }),
  'text-note': define('text-note', 'Text', 1, { text: 'Note' }),
  arrow: define('arrow', 'Arrow', 2, { headLength: 12 }),
  // One anchor, like `horizontal-line`: the direction is fixed (rightwards), so a second
  // anchor would carry no information the first does not already have.
  'horizontal-ray': define('horizontal-ray', 'Horizontal Ray', 1),
  // Three: `[baseFrom, baseTo, through]`. The first two are the base trend line, the third
  // is the point the parallel copy must pass through — the same arity as `pitchfork`.
  'parallel-channel': define('parallel-channel', 'Parallel Channel', 3),
  // Two corners. `precision` is the number of decimals in the price delta, matching the
  // position tools; the percentage is always two.
  'price-range': define('price-range', 'Price Range', 2, { precision: 2 }),
  /*
   * `barMs` is the timeframe's milliseconds per bar — `TIMEFRAME_MS[tf]` from
   * `src/data/types.ts`. It has to be a param because `buildGeometry` is given only the
   * two scales and the plot box; it can convert a bar index to an x, but nothing tells it
   * how much TIME a bar spans. The caller that creates the drawing should pass the live
   * timeframe (`store.add('date-range', anchors, { params: { barMs: TIMEFRAME_MS[tf] } })`).
   * The default of 0 means "unknown", and the annotation then reports the bar count alone
   * rather than an invented duration.
   */
  'date-range': define('date-range', 'Date Range', 2, { barMs: 0 }),
});

/** Anchors required before a drawing of `kind` is complete. */
export function anchorCountFor(kind: DrawingKind): number {
  return TOOL_DEFINITIONS[kind].anchorCount;
}
