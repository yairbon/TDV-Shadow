/**
 * Hit testing in PIXEL space against geometry derived this frame.
 *
 * Distances are pixels because that is what "close to the cursor" means to a person: a
 * price tolerance would feel tight when zoomed out and loose when zoomed in.
 */

import type { DrawingGeometry, Point } from './geometry.js';

export interface Hit {
  readonly id: string;
  /** Index of the anchor under the cursor, or -1 when the body was hit but no anchor. */
  readonly anchorIndex: number;
  readonly distance: number;
}

/** Shortest distance from a point to a finite segment. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceToBox(p: Point, box: NonNullable<DrawingGeometry['box']>): number {
  // Edge-aware: the interior of a rectangle is not a hit, only its border, so a large
  // rectangle does not swallow every click inside it.
  const corners: Point[] = [
    { x: box.x0, y: box.y0 },
    { x: box.x1, y: box.y0 },
    { x: box.x1, y: box.y1 },
    { x: box.x0, y: box.y1 },
  ];
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < corners.length; i++) {
    best = Math.min(best, distanceToSegment(p, corners[i], corners[(i + 1) % corners.length]));
  }
  return best;
}

/** Distance from a point to one drawing's geometry, or Infinity when incomplete. */
export function distanceTo(point: Point, geometry: DrawingGeometry): number {
  if (!geometry.complete) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const segment of geometry.segments) {
    best = Math.min(best, distanceToSegment(point, segment.from, segment.to));
  }
  if (geometry.box !== null) best = Math.min(best, distanceToBox(point, geometry.box));
  for (const p of geometry.points) best = Math.min(best, Math.hypot(point.x - p.x, point.y - p.y));
  return best;
}

/**
 * Hits within `tolerance`, nearest first. Anchor handles win over the body at equal
 * distance so dragging an endpoint is possible where it overlaps the line.
 */
export function hitTest(
  point: Point,
  geometries: readonly DrawingGeometry[],
  tolerance = 6,
): readonly Hit[] {
  const hits: Hit[] = [];
  for (const geometry of geometries) {
    const distance = distanceTo(point, geometry);
    if (distance > tolerance) continue;

    let anchorIndex = -1;
    let anchorDistance = Number.POSITIVE_INFINITY;
    geometry.points.forEach((p, i) => {
      const d = Math.hypot(point.x - p.x, point.y - p.y);
      if (d <= tolerance && d < anchorDistance) {
        anchorDistance = d;
        anchorIndex = i;
      }
    });

    hits.push({ id: geometry.id, anchorIndex, distance });
  }
  return hits.sort((a, b) => a.distance - b.distance);
}
