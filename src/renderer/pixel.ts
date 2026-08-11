/**
 * Pixel snapping — RENDER_ALGORITHMS §7, verbatim.
 *
 * Every value here is a CSS pixel: the DPR transform is applied once in
 * `surface.ts` and never again (§1). Unsnapped coordinates are the single most
 * common cause of blurry charts (SKILL rule 5).
 */

/** For 1px strokes: gridlines, crosshair, axis rules. */
export function snapLine(v: number): number {
  return Math.round(v) + 0.5;
}

/** For fills: candle bodies, volume columns. */
export function snapFill(v: number): number {
  return Math.round(v);
}

/**
 * Snapping for a stroke of arbitrary width: odd widths straddle a pixel centre and
 * want the half-pixel offset, even widths sit on the pixel boundary and must not.
 */
export function snapStroke(v: number, lineWidth: number): number {
  return Math.round(lineWidth) % 2 === 1 ? snapLine(v) : snapFill(v);
}

/**
 * Length of a filled span between two unsnapped edges.
 *
 * `snapFill(b) - snapFill(a)`, floored at 1 — computing `round(b - a)` instead
 * drifts against the snapped edges and collapses a doji to 0px (§7).
 */
export function fillSpan(a: number, b: number): number {
  const span = snapFill(b) - snapFill(a);
  return span < 1 ? 1 : span;
}
