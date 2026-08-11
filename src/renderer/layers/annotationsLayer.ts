/**
 * Indicator plots and drawings, painted on the overlay layer.
 *
 * Two rules carry over from the indicator contract:
 *   NaN BREAKS THE LINE. A warm-up value is "no value yet", so the polyline must start
 *   a new subpath rather than joining across it — joining draws a line from zero that
 *   looks like real data.
 *   Colours come from theme tokens, never from the indicator, so a plot cannot hard-code
 *   a colour that is invisible in one of the themes.
 */

import type { IndicatorResult, VolumeProfileResult } from '../../indicators/types.js';
import type { DrawingGeometry } from '../../drawings/geometry.js';
import { snapFill, snapLine } from '../pixel.js';
import type { Rect } from '../layout.js';
import type { Theme } from '../theme.js';

/** Resolves an indicator's token against the theme, falling back to the overlay colour. */
export function resolveToken(theme: Theme, token: string): string {
  const table: Record<string, string> = {
    overlayLine: theme.overlayLine,
    indicatorLineAlt: theme.downBody,
    indicatorBand: theme.gridLine,
    indicatorHistogram: theme.upVolume,
    indicatorProfile: theme.upVolume,
    upVolume: theme.upVolume,
  };
  return table[token] ?? theme.overlayLine;
}

export interface PlotScale {
  y(value: number): number;
}

/**
 * Per-plot appearance chosen by the user, keyed by `PlotSpec.key`.
 *
 * An override is exactly the three things a settings dialog can change; everything else
 * about a plot still comes from the indicator's own declaration. An absent entry, or an
 * absent field within one, falls back to the theme token — so the default look is defined
 * in one place and an override is genuinely an override.
 */
export interface PlotStyleOverride {
  /** Explicit CSS colour. Wins over `PlotSpec.colorToken`. */
  readonly color?: string;
  readonly lineWidth?: number;
  readonly dash?: readonly number[];
}

export type PlotStyles = Readonly<Record<string, PlotStyleOverride>>;

export interface OverlayInput {
  readonly plot: Rect;
  readonly theme: Theme;
  readonly from: number;
  readonly to: number;
  x(index: number): number;
}

function clip(ctx: CanvasRenderingContext2D, rect: Rect): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.left, rect.top, rect.width, rect.height);
  ctx.clip();
}

/** Strokes one plot, breaking the path wherever the value is NaN. */
function strokePlot(
  ctx: CanvasRenderingContext2D,
  values: Float64Array,
  input: OverlayInput,
  scale: PlotScale,
  color: string,
  override: PlotStyleOverride = {},
): void {
  ctx.strokeStyle = override.color ?? color;
  ctx.lineWidth = override.lineWidth ?? 1.5;
  ctx.setLineDash(override.dash === undefined ? [] : [...override.dash]);
  ctx.beginPath();
  let drawing = false;
  for (let i = input.from; i <= input.to; i++) {
    const value = values[i];
    if (Number.isNaN(value)) {
      drawing = false;
      continue;
    }
    const x = snapLine(input.x(i));
    const y = snapLine(scale.y(value));
    if (drawing) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    drawing = true;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function fillHistogram(
  ctx: CanvasRenderingContext2D,
  values: Float64Array,
  input: OverlayInput,
  scale: PlotScale,
  theme: Theme,
  barWidth: number,
): void {
  const zeroY = snapFill(scale.y(0));
  for (let i = input.from; i <= input.to; i++) {
    const value = values[i];
    if (Number.isNaN(value)) continue;
    const y = snapFill(scale.y(value));
    ctx.fillStyle = value >= 0 ? theme.upVolume : theme.downVolume;
    const top = Math.min(y, zeroY);
    ctx.fillRect(snapFill(input.x(i)) - barWidth / 2, top, Math.max(1, barWidth), Math.max(1, Math.abs(y - zeroY)));
  }
}

/** Draws an overlay indicator on the price plot. */
export function drawIndicatorOverlay(
  ctx: CanvasRenderingContext2D,
  result: IndicatorResult,
  input: OverlayInput,
  scale: PlotScale,
  styles: PlotStyles = {},
): void {
  clip(ctx, input.plot);
  for (const plot of result.plots) {
    const values = result.values[plot.key];
    if (plot.style === 'histogram') continue;
    strokePlot(ctx, values, input, scale, resolveToken(input.theme, plot.colorToken), styles[plot.key]);
  }
  ctx.restore();
}

/** Draws a Volume Profile as horizontal rows anchored to the right edge of the plot. */
export function drawVolumeProfile(
  ctx: CanvasRenderingContext2D,
  profile: VolumeProfileResult,
  input: OverlayInput,
  scale: PlotScale,
): void {
  if (profile.buckets.length === 0) return;
  clip(ctx, input.plot);

  let peak = 0;
  for (const bucket of profile.buckets) peak = Math.max(peak, bucket.volume);
  if (peak <= 0) {
    ctx.restore();
    return;
  }

  const maxWidth = input.plot.width * 0.22;
  const rowHeight = Math.max(
    1,
    Math.abs(scale.y(profile.buckets[0].price) - scale.y(profile.buckets[Math.min(1, profile.buckets.length - 1)].price)) - 1,
  );

  for (const bucket of profile.buckets) {
    const width = (bucket.volume / peak) * maxWidth;
    const inValueArea = bucket.price >= profile.valueAreaLow && bucket.price <= profile.valueAreaHigh;
    ctx.fillStyle = resolveToken(input.theme, 'indicatorProfile');
    ctx.globalAlpha = inValueArea ? 0.5 : 0.22;
    ctx.fillRect(input.plot.left, snapFill(scale.y(bucket.price) - rowHeight / 2), Math.max(1, width), rowHeight);
  }
  ctx.globalAlpha = 1;

  // Point of control gets a solid marker — it is the one level traders look for.
  ctx.fillStyle = input.theme.overlayLine;
  ctx.fillRect(input.plot.left, snapFill(scale.y(profile.pointOfControl)), maxWidth, 1);
  ctx.restore();
}

/** Draws a pane indicator (RSI, MACD, ATR, Stochastic, Volume) in its own rect. */
export function drawIndicatorPane(
  ctx: CanvasRenderingContext2D,
  result: IndicatorResult,
  input: OverlayInput,
  pane: Rect,
  barWidth: number,
  styles: PlotStyles = {},
): void {
  // Pane scale: fixed bounds when the indicator declares them (RSI 0..100), else
  // autoscale over the visible values only.
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  if (result.scaleBounds !== null) {
    [min, max] = result.scaleBounds;
  } else {
    for (const plot of result.plots) {
      const values = result.values[plot.key];
      for (let i = input.from; i <= input.to; i++) {
        const v = values[i];
        if (Number.isNaN(v)) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.1;
    min -= pad;
    max += pad;
    if (result.guides.includes(0)) {
      // Keep zero visible for signed indicators, otherwise the histogram has no baseline.
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
  }

  const scale: PlotScale = { y: (value) => pane.top + ((max - value) / (max - min)) * pane.height };

  clip(ctx, pane);

  ctx.strokeStyle = input.theme.gridLine;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const guide of result.guides) {
    const y = snapLine(scale.y(guide));
    ctx.beginPath();
    ctx.moveTo(pane.left, y);
    ctx.lineTo(pane.left + pane.width, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const plot of result.plots) {
    const values = result.values[plot.key];
    if (plot.style === 'histogram') {
      fillHistogram(ctx, values, input, scale, input.theme, barWidth);
      continue;
    }
    strokePlot(ctx, values, input, scale, resolveToken(input.theme, plot.colorToken), styles[plot.key]);
  }

  ctx.restore();
}

/** Draws all drawing geometry. */
export function drawDrawings(
  ctx: CanvasRenderingContext2D,
  geometries: readonly DrawingGeometry[],
  plot: Rect,
  theme: Theme,
  selectedId: string | null,
): void {
  clip(ctx, plot);
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  for (const geometry of geometries) {
    if (!geometry.complete) continue;
    const selected = geometry.id === selectedId;
    ctx.strokeStyle = selected ? theme.crosshairLine : theme.overlayLine;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = selected ? 2 : 1.5;

    for (const segment of geometry.segments) {
      ctx.beginPath();
      ctx.moveTo(snapLine(segment.from.x), snapLine(segment.from.y));
      ctx.lineTo(snapLine(segment.to.x), snapLine(segment.to.y));
      ctx.stroke();
    }

    if (geometry.box !== null) {
      ctx.globalAlpha = 0.12;
      ctx.fillRect(
        snapFill(geometry.box.x0),
        snapFill(geometry.box.y0),
        Math.max(1, snapFill(geometry.box.x1) - snapFill(geometry.box.x0)),
        Math.max(1, snapFill(geometry.box.y1) - snapFill(geometry.box.y0)),
      );
      ctx.globalAlpha = 1;
      ctx.strokeRect(
        snapLine(geometry.box.x0),
        snapLine(geometry.box.y0),
        Math.max(1, geometry.box.x1 - geometry.box.x0),
        Math.max(1, geometry.box.y1 - geometry.box.y0),
      );
    }

    ctx.fillStyle = theme.axisText;
    for (const level of geometry.levels) {
      ctx.fillText(level.label, plot.left + 6, snapLine(level.y) - 7);
    }
    for (const label of geometry.labels) {
      ctx.fillText(label.text, label.x + 6, label.y);
    }

    // Anchor handles, so it is obvious what can be grabbed.
    ctx.fillStyle = selected ? theme.crosshairLine : theme.overlayLine;
    for (const point of geometry.points) {
      ctx.fillRect(snapFill(point.x) - 2, snapFill(point.y) - 2, 5, 5);
    }
  }
  ctx.restore();
}


/**
 * Last-price line and axis badge — the single most-read element on a trading chart.
 *
 * The dashed line is clipped to the plot, but the badge deliberately is NOT: it belongs
 * in the price gutter, which sits outside the plot rect. Clipping it would hide it.
 */
export function drawLastPrice(
  ctx: CanvasRenderingContext2D,
  price: number,
  rising: boolean,
  plot: Rect,
  gutter: Rect,
  theme: Theme,
  scale: PlotScale,
  precision: number,
): void {
  const y = snapLine(scale.y(price));
  if (y < plot.top - 1 || y > plot.top + plot.height + 1) return;

  const color = rising ? theme.upBody : theme.downBody;

  clip(ctx, plot);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(plot.left, y);
  ctx.lineTo(plot.left + plot.width, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  const label = price.toFixed(precision);
  ctx.font = theme.typography.font;
  ctx.textBaseline = 'middle';
  const height = theme.density.axisLabelHeight;
  const width = Math.max(gutter.width - 2, ctx.measureText(label).width + 12);

  ctx.fillStyle = color;
  ctx.fillRect(snapFill(gutter.left), snapFill(y - height / 2), snapFill(width), height);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, gutter.left + 6, y);
}


/**
 * Symbol watermark behind the series — drawn on the GRID layer so the candles sit on top
 * of it. Painting it on the overlay would put it over the data, which is backwards.
 */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  symbol: string,
  timeframe: string,
  plot: Rect,
  theme: Theme,
): void {
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = theme.axisTextStrong;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const size = Math.min(96, Math.max(28, plot.width * 0.075));
  ctx.font = `600 ${String(Math.round(size))}px ${theme.typography.fontFamily}`;
  ctx.fillText(symbol, plot.left + plot.width / 2, plot.top + plot.height / 2 - size * 0.35);
  ctx.font = `400 ${String(Math.round(size * 0.42))}px ${theme.typography.fontFamily}`;
  ctx.fillText(timeframe, plot.left + plot.width / 2, plot.top + plot.height / 2 + size * 0.45);
  ctx.restore();
}
