/**
 * Placement preview — the rubber band drawn while a drawing is still being placed.
 *
 * ON THE CROSSHAIR LAYER, NOT THE OVERLAY. Mandate #2 says every frame clears its layer,
 * and the crosshair layer is the one that already clears and repaints on every pointer
 * move; the overlay repaints only on data/annotation changes. A rubber band that follows
 * the cursor therefore belongs here, exactly like the shift-drag ruler in
 * `drawMeasure`. Painting it on the overlay would either lag the cursor by a frame or
 * force the indicator layer to redraw on every mouse move.
 *
 * The persistent path (`drawDrawings`) keeps its `if (!geometry.complete) continue` gate on
 * purpose — a half-placed shape must never be hit-testable, selectable, undoable or
 * saveable. This is the separate path that paints one, and it paints it as visibly
 * PROVISIONAL: dashed, dimmed, in the crosshair colour rather than the drawing's own.
 *
 * Point convention, produced by `buildPreviewGeometry`: the LAST entry of `geometry.points`
 * is the floating cursor anchor and every entry before it is already pinned. Pinned anchors
 * get solid handles, the cursor gets a smaller hollow marker, so "what I have committed"
 * and "what moves with my mouse" never read the same.
 */

import type { DrawingGeometry } from '../../drawings/geometry.js';
import type { Rect } from '../layout.js';
import { snapFill, snapLine } from '../pixel.js';
import type { Theme } from '../theme.js';

/** Dash pattern for every provisional stroke. Longer than the crosshair's own 4/4 so the
 * two read as different things when they cross. */
export const PREVIEW_DASH: readonly number[] = Object.freeze([6, 4]);

/** Provisional strokes are dimmed; committed drawings paint at their own style opacity. */
export const PREVIEW_ALPHA = 0.65;

/** Half-size of a solid handle on an anchor the user has already clicked. */
const PLACED_HANDLE_HALF = 3;

/** Half-size of the hollow marker that rides the cursor. Smaller on purpose. */
const CURSOR_MARKER_HALF = 2;

/**
 * Draws the in-progress drawing onto the crosshair layer.
 *
 * `geometry` is expected to come from `buildPreviewGeometry`, i.e. `complete === false`
 * with its segments/box/points fully populated.
 */
export function drawPlacementPreview(
  ctx: CanvasRenderingContext2D,
  geometry: DrawingGeometry,
  plot: Rect,
  theme: Theme,
): void {
  if (geometry.segments.length === 0 && geometry.box === null && geometry.points.length === 0) {
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();

  // Never a hard-coded colour: the preview is chrome, so it takes the chrome colour the
  // theme already defines for pointer-following furniture.
  ctx.strokeStyle = theme.crosshairLine;
  ctx.fillStyle = theme.crosshairLine;
  ctx.lineWidth = 1;
  ctx.globalAlpha = PREVIEW_ALPHA;
  ctx.setLineDash([...PREVIEW_DASH]);

  for (const segment of geometry.segments) {
    ctx.beginPath();
    ctx.moveTo(snapLine(segment.from.x), snapLine(segment.from.y));
    ctx.lineTo(snapLine(segment.to.x), snapLine(segment.to.y));
    ctx.stroke();
  }

  if (geometry.box !== null) {
    // Outline only. The committed rectangle carries a fill; leaving it off here is another
    // channel saying "not placed yet", and it keeps the candles under it readable while the
    // box is being sized.
    ctx.strokeRect(
      snapLine(geometry.box.x0),
      snapLine(geometry.box.y0),
      Math.max(1, geometry.box.x1 - geometry.box.x0),
      Math.max(1, geometry.box.y1 - geometry.box.y0),
    );
  }

  ctx.setLineDash([]);

  // Handles are not dashed and not dimmed: a pinned anchor is a fact, not a proposal.
  const cursorIndex = geometry.points.length - 1;
  ctx.globalAlpha = 1;
  for (let i = 0; i < cursorIndex; i++) {
    const point = geometry.points[i];
    ctx.fillRect(
      snapFill(point.x) - PLACED_HANDLE_HALF,
      snapFill(point.y) - PLACED_HANDLE_HALF,
      PLACED_HANDLE_HALF * 2 + 1,
      PLACED_HANDLE_HALF * 2 + 1,
    );
  }

  if (cursorIndex >= 0) {
    const cursor = geometry.points[cursorIndex];
    ctx.globalAlpha = PREVIEW_ALPHA;
    ctx.strokeRect(
      snapLine(cursor.x - CURSOR_MARKER_HALF),
      snapLine(cursor.y - CURSOR_MARKER_HALF),
      CURSOR_MARKER_HALF * 2,
      CURSOR_MARKER_HALF * 2,
    );
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}
