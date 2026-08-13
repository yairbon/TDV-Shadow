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
    // A third line colour, for indicators that plot more than two at once. Ichimoku is
    // five lines; with only two tokens two of them came out identical.
    indicatorLineThird: theme.axisTextStrong,
    indicatorBand: theme.gridLine,
    indicatorHistogram: theme.upVolume,
    indicatorProfile: theme.upVolume,
    upVolume: theme.upVolume,
  };
  return table[token] ?? theme.overlayLine;
}

/**
 * Drawing colour tokens. Separate from `resolveToken`, which serves indicator plots: a
 * drawing's palette is about standing out ON the chart, not about matching a series.
 */
export function resolveDrawingToken(theme: Theme, token: string): string {
  const table: Record<string, string | undefined> = {
    'drawing.primary': theme.overlayLine,
    'drawing.up': theme.upBody,
    'drawing.down': theme.downBody,
    'drawing.neutral': theme.axisText,
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
  /**
   * The same §5 map as `x`, as the affine pair `x(i) = x0 + i * dx`.
   *
   * Supplied so the dense (sub-pixel) paths can compute a column with two arithmetic ops
   * instead of an indirect call. At 100k visible bars and three indicators that call was
   * 300k invocations per frame — measurably most of the overlay's cost.
   */
  readonly x0: number;
  readonly dx: number;
}

function clip(ctx: CanvasRenderingContext2D, rect: Rect): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.left, rect.top, rect.width, rect.height);
  ctx.clip();
}

/**
 * Strokes one plot, breaking the path wherever the value is NaN.
 *
 * Above one bar per pixel column the polyline is reduced to two points per column — the
 * minimum and the maximum value in it, in that order (§5.1). One point per column would
 * be faster still and would flatten every spike; keeping both preserves the envelope,
 * which is the only thing a sub-pixel line can honestly show. At 100k visible bars this
 * is the difference between ~2400 `lineTo` calls and 100k of them, per indicator, per
 * frame.
 */
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

  const dense = input.to - input.from + 1 > input.plot.width;
  const x0 = input.x0;
  const dx = input.dx;
  let drawing = false;
  let column = Number.NaN;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;

  const flush = (): void => {
    if (!Number.isFinite(lo)) return;
    const x = snapLine(column);
    // Low first, then high: the path then walks the column's full extent rather than
    // jumping across it.
    const yLo = snapLine(scale.y(lo));
    const yHi = snapLine(scale.y(hi));
    if (drawing) ctx.lineTo(x, yLo);
    else ctx.moveTo(x, yLo);
    ctx.lineTo(x, yHi);
    drawing = true;
    lo = Number.POSITIVE_INFINITY;
    hi = Number.NEGATIVE_INFINITY;
  };

  for (let i = input.from; i <= input.to; i++) {
    const value = values[i];
    if (Number.isNaN(value)) {
      if (dense) flush();
      drawing = false;
      continue;
    }
    if (!dense) {
      const x = snapLine(input.x(i));
      const y = snapLine(scale.y(value));
      if (drawing) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      drawing = true;
      continue;
    }

    const next = Math.round(x0 + i * dx);
    if (next !== column) {
      flush();
      column = next;
    }
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (dense) flush();

  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * One dot per bar, for a plot that is a series of levels rather than a path.
 *
 * The parabolic SAR is why this exists: its value jumps from above price to below it on
 * every reversal, and a stroked path draws that jump as a near-vertical line across the
 * candles — a line the indicator does not have. Dots also say what SAR means, which is a
 * stop level for each bar and not a trend of its own.
 *
 * Sub-pixel bar spacing collapses the dots onto shared columns; at that density they are
 * a band rather than a sequence, which is the honest reading of a hundred stops inside
 * one pixel, so no aggregation is attempted beyond letting them overlap.
 */
function drawDots(
  ctx: CanvasRenderingContext2D,
  values: Float64Array,
  input: OverlayInput,
  scale: PlotScale,
  color: string,
  override: PlotStyleOverride = {},
): void {
  ctx.fillStyle = override.color ?? color;
  const radius = Math.max(1, (override.lineWidth ?? 1.5) * 0.9);
  for (let i = input.from; i <= input.to; i++) {
    const value = values[i];
    if (Number.isNaN(value)) continue;
    ctx.beginPath();
    // snapFill, not snapLine: §7's half-pixel offset is for 1px STROKES, where it puts the
    // line on a pixel rather than straddling two. A filled disc centred on a half pixel is
    // the blurred case, not the crisp one.
    ctx.arc(snapFill(input.x(i)), snapFill(scale.y(value)), radius, 0, Math.PI * 2);
    ctx.fill();
  }
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
  const dense = input.to - input.from + 1 > input.plot.width;

  // Dense: one bar per column, taking the value furthest from zero — the extreme is what
  // a histogram is read for, and 100k overlapping fillRects would leave whichever bar
  // happened to be last anyway.
  let column = Number.NaN;
  let extreme = 0;

  const flush = (): void => {
    if (!Number.isFinite(column) || extreme === 0) return;
    const y = snapFill(scale.y(extreme));
    ctx.fillStyle = extreme >= 0 ? theme.upVolume : theme.downVolume;
    ctx.fillRect(column, Math.min(y, zeroY), 1, Math.max(1, Math.abs(y - zeroY)));
    extreme = 0;
  };

  for (let i = input.from; i <= input.to; i++) {
    const value = values[i];
    if (Number.isNaN(value)) continue;
    if (!dense) {
      const y = snapFill(scale.y(value));
      ctx.fillStyle = value >= 0 ? theme.upVolume : theme.downVolume;
      const top = Math.min(y, zeroY);
      ctx.fillRect(
        snapFill(input.x(i)) - barWidth / 2,
        top,
        Math.max(1, barWidth),
        Math.max(1, Math.abs(y - zeroY)),
      );
      continue;
    }
    const next = Math.round(input.x0 + i * input.dx);
    if (next !== column) {
      flush();
      column = next;
    }
    if (Math.abs(value) > Math.abs(extreme)) extreme = value;
  }
  if (dense) flush();
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
    const color = resolveToken(input.theme, plot.colorToken);
    if (plot.style === 'dots') drawDots(ctx, values, input, scale, color, styles[plot.key]);
    else strokePlot(ctx, values, input, scale, color, styles[plot.key]);
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
    const color = resolveToken(input.theme, plot.colorToken);
    if (plot.style === 'dots') drawDots(ctx, values, input, scale, color, styles[plot.key]);
    else strokePlot(ctx, values, input, scale, color, styles[plot.key]);
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
    const style = geometry.style;
    // The drawing's own colour survives selection: a red trendline that turns grey the
    // moment you click it is worse feedback than no feedback. Selection reads as a
    // thicker line plus larger handles instead.
    const color = style.color ?? resolveDrawingToken(theme, style.colorToken);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = style.lineWidth + (selected ? 1 : 0.5);
    ctx.globalAlpha = style.opacity;
    ctx.setLineDash([...style.dash]);

    for (const segment of geometry.segments) {
      ctx.beginPath();
      ctx.moveTo(snapLine(segment.from.x), snapLine(segment.from.y));
      ctx.lineTo(snapLine(segment.to.x), snapLine(segment.to.y));
      ctx.stroke();
    }

    if (geometry.box !== null) {
      ctx.globalAlpha = style.opacity * 0.12;
      ctx.fillRect(
        snapFill(geometry.box.x0),
        snapFill(geometry.box.y0),
        Math.max(1, snapFill(geometry.box.x1) - snapFill(geometry.box.x0)),
        Math.max(1, snapFill(geometry.box.y1) - snapFill(geometry.box.y0)),
      );
      ctx.globalAlpha = style.opacity;
      ctx.strokeRect(
        snapLine(geometry.box.x0),
        snapLine(geometry.box.y0),
        Math.max(1, geometry.box.x1 - geometry.box.x0),
        Math.max(1, geometry.box.y1 - geometry.box.y0),
      );
    }

    ctx.setLineDash([]);

    if (style.showLabels) {
      ctx.fillStyle = theme.axisText;
      for (const level of geometry.levels) {
        // At the level's own left edge, not the plot's. A fib drawn in the middle of the
        // chart used to label itself over on the far left, on top of the legend and
        // pointing at nothing. Clamped so a drawing dragged half off-screen keeps its
        // labels inside the plot rather than under the price gutter.
        const width = ctx.measureText(level.label).width;
        const x = Math.min(
          Math.max(level.x + 6, plot.left + 6),
          plot.left + plot.width - width - 4,
        );
        ctx.fillText(level.label, x, snapLine(level.y) - 7);
      }
      for (const label of geometry.labels) {
        ctx.fillText(label.text, label.x + 6, label.y);
      }
    }

    // Anchor handles, so it is obvious what can be grabbed. Handles are never dashed or
    // faded — they are chrome for the selection, not part of the drawing.
    ctx.globalAlpha = 1;
    ctx.fillStyle = selected ? theme.crosshairLine : color;
    const half = selected ? 4 : 2;
    for (const point of geometry.points) {
      ctx.fillRect(snapFill(point.x) - half, snapFill(point.y) - half, half * 2 + 1, half * 2 + 1);
    }
  }
  ctx.globalAlpha = 1;
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

/** A measurement in PIXELS, already projected by the caller. */
export interface MeasureGeometry {
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly priceDelta: number;
  readonly percentDelta: number;
  readonly bars: number;
  readonly elapsed: string;
  readonly pricePrecision: number;
}

/**
 * Draws the shift-drag ruler on the crosshair layer.
 *
 * On the crosshair layer, not the overlay, because a measurement is transient chrome that
 * follows the pointer: the overlay repaints only on Overlay-dirty frames, so dragging a
 * ruler there would either lag the cursor or force the indicator layer to redraw on every
 * pointer move.
 */
export function drawMeasure(
  ctx: CanvasRenderingContext2D,
  m: MeasureGeometry,
  plot: Rect,
  theme: Theme,
): void {
  const rising = m.priceDelta >= 0;
  const accent = rising ? theme.upBody : theme.downBody;

  clip(ctx, plot);

  const x0 = Math.min(m.from.x, m.to.x);
  const x1 = Math.max(m.from.x, m.to.x);
  const y0 = Math.min(m.from.y, m.to.y);
  const y1 = Math.max(m.from.y, m.to.y);

  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.14;
  ctx.fillRect(snapFill(x0), snapFill(y0), Math.max(1, snapFill(x1) - snapFill(x0)), Math.max(1, snapFill(y1) - snapFill(y0)));
  ctx.globalAlpha = 1;

  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(snapLine(x0), snapLine(y0), Math.max(1, x1 - x0), Math.max(1, y1 - y0));

  // The direction arrow runs from the grab point to the cursor, so an upward measurement
  // reads as upward even when the box is drawn from its top-left corner.
  ctx.beginPath();
  ctx.moveTo(snapLine(m.from.x), snapLine(m.from.y));
  ctx.lineTo(snapLine(m.to.x), snapLine(m.to.y));
  ctx.stroke();

  const sign = m.priceDelta >= 0 ? '+' : '';
  const top = `${sign}${m.priceDelta.toFixed(m.pricePrecision)} (${sign}${m.percentDelta.toFixed(2)}%)`;
  const bottom = `${String(m.bars)} bar${m.bars === 1 ? '' : 's'}, ${m.elapsed}`;

  ctx.font = theme.typography.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const width = Math.max(ctx.measureText(top).width, ctx.measureText(bottom).width) + 16;
  const height = 34;
  // Anchored below the cursor when measuring downward and above when measuring upward, so
  // the label never covers the bar the pointer is on.
  const labelX = Math.min(Math.max(m.to.x, plot.left + width / 2), plot.left + plot.width - width / 2);
  const labelY = Math.min(
    Math.max(m.to.y + (m.to.y >= m.from.y ? height : -height), plot.top + height / 2),
    plot.top + plot.height - height / 2,
  );

  ctx.fillStyle = accent;
  ctx.fillRect(snapFill(labelX - width / 2), snapFill(labelY - height / 2), width, height);
  ctx.fillStyle = theme.labelText;
  ctx.fillText(top, labelX, labelY - 8);
  ctx.fillText(bottom, labelX, labelY + 8);

  ctx.textAlign = 'left';
  ctx.restore();
}

/** One alert level, already projected. */
export interface AlertGeometry {
  readonly id: string;
  readonly y: number;
  readonly price: number;
  readonly triggered: boolean;
}

/**
 * Draws alert levels across the plot with a price tag in the gutter.
 *
 * A triggered alert is drawn solid and in the accent colour; an armed one is dashed and
 * dim. The distinction has to be visible at a glance — an alert that has already fired is
 * history, and reading it as a live level is how people act on a stale line.
 */
export function drawAlerts(
  ctx: CanvasRenderingContext2D,
  alerts: readonly AlertGeometry[],
  plot: Rect,
  gutter: Rect,
  theme: Theme,
  pricePrecision: number,
): void {
  if (alerts.length === 0) return;
  ctx.save();
  ctx.font = theme.typography.font;
  ctx.textBaseline = 'middle';

  for (const alert of alerts) {
    if (alert.y < plot.top - 1 || alert.y > plot.top + plot.height + 1) continue;
    const color = alert.triggered ? theme.upBody : theme.overlayLine;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(alert.triggered ? [] : [5, 4]);
    ctx.globalAlpha = alert.triggered ? 1 : 0.75;
    ctx.beginPath();
    ctx.moveTo(plot.left, snapLine(alert.y));
    ctx.lineTo(plot.left + plot.width, snapLine(alert.y));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const label = alert.price.toFixed(pricePrecision);
    const height = theme.typography.lineHeight + 4;
    ctx.fillStyle = color;
    ctx.fillRect(gutter.left, snapFill(alert.y - height / 2), gutter.width, height);
    ctx.fillStyle = theme.labelText;
    ctx.fillText(label, gutter.left + 6, alert.y);
  }

  ctx.restore();
}
