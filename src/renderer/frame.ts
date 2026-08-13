/**
 * The immutable per-frame input every layer paints from.
 *
 * Built once at frame start from a frozen snapshot (mandate #4) and handed to each
 * dirty layer. Nothing in here reads a store, fetches, or writes state — the
 * renderer is pure paint.
 *
 * Snapshot liveness (ARCHITECTURE.md §3): a `Snapshot` is a frozen five-field
 * wrapper whose `series.bars` array is shared by reference, not copied. It is only
 * valid for the synchronous frame that took it:
 *
 *   - build the `FrameInput`, draw, and drop it inside one rAF callback;
 *   - never `await` between taking the snapshot and finishing the draw;
 *   - never keep a snapshot to diff against a later one — the array it points at has
 *     already moved on, so `bars.length` and last-bar comparisons silently lie.
 *
 * Change detection is `snapshot.revision` and nothing else, which is what
 * `AutoscaleCache` keys on below.
 */

import type { BarIndex, Snapshot } from '../data/types.js';
import { asPrice, TIMEFRAME_MS } from '../data/types.js';
import type { Layout } from './layout.js';
import type { Overlay } from './layers/overlayLayer.js';
import { overlayPriceExtent } from './layers/overlayLayer.js';
import {
  autoscale,
  makePriceScale,
  percentBase,
  type PriceRange,
  type PriceScale,
} from './scale/priceScale.js';
import { makeTimeScale, type TimeScale, type VisibleRange } from './scale/timeScale.js';
import type { TimeZone } from './scale/timezone.js';
import type { Theme } from './theme.js';

/** Pointer position in CSS px, or null when the pointer is not over the chart. */
export interface PointerState {
  readonly x: number;
  readonly y: number;
}

export interface FrameInput {
  readonly snapshot: Snapshot;
  readonly layout: Layout;
  readonly theme: Theme;
  readonly priceScale: PriceScale;
  /**
   * A second price scale for the left gutter, or null when there is only one.
   *
   * Exists for series whose units are not the primary's — a compared instrument read in
   * its own prices rather than as a percent of the primary. Null and absent are the same
   * thing here: no left axis is drawn and no space is reserved for one.
   */
  readonly leftPriceScale: PriceScale | null;
  readonly timeScale: TimeScale;
  readonly visible: VisibleRange;
  /** Decimal cap for price labels — the instrument's precision. */
  readonly pricePrecision: number;
  readonly overlays: readonly Overlay[];
  readonly pointer: PointerState | null;
  /** Milliseconds per bar for the snapshot's timeframe; drives time-tick units. */
  readonly timeframeMs: number;
  /**
   * Whether the grid rules are painted. Axis rules, ticks and labels are unaffected —
   * "no gridlines" means a clean plot, not an unreadable one.
   */
  readonly showGrid: boolean;
  /**
   * Display timezone for every time LABEL and for where a session break falls (10.2).
   * The data stays UTC epoch ms; this never touches a bar, an index or a coordinate.
   */
  readonly timeZone: TimeZone;
}

/**
 * §4: "Recompute only when the visible index range or the underlying bars change —
 * never per frame."
 *
 * The key is `(revision, from, to)`. `revision` is the store's monotonic counter:
 * equal revision means identical content, and it is the ONLY safe change signal —
 * the bars array is live, so its identity and length are not evidence of anything.
 * Overlays are not part of the key (their values are derived from the bars), so a
 * caller that swaps the overlay set must `clear()`.
 */
export interface AutoscaleCache {
  range(revision: number, from: BarIndex, to: BarIndex, compute: () => PriceRange): PriceRange;
  clear(): void;
}

export function createAutoscaleCache(): AutoscaleCache {
  let revision = Number.NaN;
  let from = Number.NaN;
  let to = Number.NaN;
  let cached: PriceRange | null = null;

  return {
    range: (rev: number, f: BarIndex, t: BarIndex, compute: () => PriceRange): PriceRange => {
      const hit = cached;
      if (hit !== null && rev === revision && f === from && t === to) return hit;
      revision = rev;
      from = f;
      to = t;
      const next = compute();
      cached = next;
      return next;
    },
    clear: (): void => {
      cached = null;
      revision = Number.NaN;
    },
  };
}

export interface FrameInputOptions {
  readonly snapshot: Snapshot;
  readonly layout: Layout;
  readonly theme: Theme;
  readonly pricePrecision: number;
  readonly overlays: readonly Overlay[];
  readonly pointer: PointerState | null;
  /** Explicit price range (manual scale drag). Null autoscales per §4. */
  readonly priceRange: PriceRange | null;
  /** §2.1 — reflects the price map so high prices sit at the bottom. */
  readonly priceScaleInverted?: boolean;
  /** Domain for the optional left axis. Absent means no second scale. */
  readonly leftPriceRange?: PriceRange;
  /** Defaults to true; false hides the grid rules only. */
  readonly showGrid?: boolean;
  /** IANA zone name for labels. Defaults to 'UTC'. */
  readonly timeZone?: TimeZone;
  /**
   * Memo for the §4 autoscale. Create one per chart and pass it every frame;
   * omitting it recomputes the range on every frame, which §4 forbids for anything
   * but a one-off render.
   */
  readonly autoscaleCache?: AutoscaleCache;
}

export function buildFrameInput(o: FrameInputOptions): FrameInput {
  // The bars array is live: read it here, inside the frame, and never retain it.
  const bars = o.snapshot.series.bars;
  const timeScale = makeTimeScale(o.snapshot.scrollPosition, o.snapshot.barSpacing, o.layout.plot);
  const visible = timeScale.visibleRange(bars.length);

  const computeRange = (): PriceRange =>
    autoscale(
      bars,
      visible.from,
      visible.to,
      visible.isEmpty ? null : overlayPriceExtent(o.overlays, visible.from, visible.to),
    );
  const cache = o.autoscaleCache;
  const range =
    o.priceRange ??
    (cache === undefined
      ? computeRange()
      : cache.range(o.snapshot.revision, visible.from, visible.to, computeRange));
  const priceScale = makePriceScale(
    range,
    o.layout.plot,
    o.snapshot.priceScaleMode,
    percentBase(bars, visible.from),
    o.priceScaleInverted ?? false,
  );

  return Object.freeze({
    snapshot: o.snapshot,
    layout: o.layout,
    theme: o.theme,
    priceScale,
    leftPriceScale:
      o.leftPriceRange === undefined
        ? null
        : makePriceScale(
            o.leftPriceRange,
            o.layout.plot,
            // Always linear: the left axis carries a second instrument's own prices, and
            // inheriting the primary's log or percent mode would relabel it in units the
            // series it describes was never expressed in.
            'linear',
            asPrice(1),
            o.priceScaleInverted ?? false,
          ),
    timeScale,
    visible,
    pricePrecision: o.pricePrecision,
    overlays: o.overlays,
    pointer: o.pointer,
    timeframeMs: TIMEFRAME_MS[o.snapshot.series.tf],
    showGrid: o.showGrid ?? true,
    timeZone: o.timeZone ?? 'UTC',
  });
}
