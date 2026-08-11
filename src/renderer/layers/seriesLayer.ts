/**
 * Series layer: candles (RENDER_ALGORITHMS §6) and the volume subpanel (§9).
 *
 * Shape of a pass:
 *   1. clear the layer (SKILL rule 2)
 *   2. slice the visible index range *before* looping (SKILL performance budget)
 *   3. one geometry pass into preallocated buffers — no allocation per bar
 *   4. batched fills grouped by colour: up wicks, down wicks, up bodies, down bodies,
 *      then the two volume passes. Six `fillStyle` writes per frame, never one per bar.
 *
 * Every coordinate is snapped per §7 before it reaches `fillRect`.
 */

import { asBarIndex } from '../../data/types.js';
import type { FrameInput } from '../frame.js';
import { rectBottom } from '../layout.js';
import { fillSpan, snapFill } from '../pixel.js';
import { candleGeometry } from '../scale/timeScale.js';
import { makeVolumeScale, maxVolume } from '../scale/volumeScale.js';

/** Geometry for one frame's visible bars, reused across frames. */
class GeometryBuffers {
  capacity = 0;
  centre = new Float64Array(0);
  bodyTop = new Float64Array(0);
  bodyHeight = new Float64Array(0);
  wickTop = new Float64Array(0);
  wickHeight = new Float64Array(0);
  volumeTop = new Float64Array(0);
  volumeHeight = new Float64Array(0);
  up = new Int32Array(0);
  down = new Int32Array(0);
  upCount = 0;
  downCount = 0;

  ensure(n: number): void {
    if (this.capacity >= n) return;
    const size = Math.max(n, this.capacity * 2, 1024);
    this.centre = new Float64Array(size);
    this.bodyTop = new Float64Array(size);
    this.bodyHeight = new Float64Array(size);
    this.wickTop = new Float64Array(size);
    this.wickHeight = new Float64Array(size);
    this.volumeTop = new Float64Array(size);
    this.volumeHeight = new Float64Array(size);
    this.up = new Int32Array(size);
    this.down = new Int32Array(size);
    this.capacity = size;
  }
}

export interface SeriesLayer {
  draw(ctx: CanvasRenderingContext2D, f: FrameInput): void;
}

class CandleSeriesLayer implements SeriesLayer {
  readonly #buf = new GeometryBuffers();

  draw(ctx: CanvasRenderingContext2D, f: FrameInput): void {
    const view = f.layout.viewport;
    ctx.clearRect(0, 0, view.width, view.height);
    if (f.visible.isEmpty) return;

    const bars = f.snapshot.series.bars;
    const from: number = f.visible.from;
    const to: number = f.visible.to;
    const buf = this.#buf;
    buf.ensure(f.visible.count);

    const candle = candleGeometry(f.timeScale.barSpacing);
    const pane = f.layout.volume;
    const volumeScale =
      pane === null ? null : makeVolumeScale(pane, maxVolume(bars, f.visible.from, f.visible.to));
    const volumeBottom = pane === null ? 0 : snapFill(rectBottom(pane));

    // --- geometry pass ------------------------------------------------------
    let count = 0;
    let upCount = 0;
    let downCount = 0;
    for (let i = from; i <= to; i++) {
      const bar = bars[i];
      if (!f.priceScale.accepts(bar.l)) continue; // §3: p <= 0 is dropped on a log scale

      const yOpen: number = f.priceScale.y(bar.o);
      const yClose: number = f.priceScale.y(bar.c);
      const yHigh: number = f.priceScale.y(bar.h);
      const yLow: number = f.priceScale.y(bar.l);
      if (
        !Number.isFinite(yOpen) ||
        !Number.isFinite(yClose) ||
        !Number.isFinite(yHigh) ||
        !Number.isFinite(yLow)
      ) {
        continue;
      }

      const slot = count;
      buf.centre[slot] = snapFill(f.timeScale.x(asBarIndex(i)));
      // §7: snap both edges, then floor the span at 1 — a doji is a 1px line, never 0.
      buf.bodyTop[slot] = snapFill(yOpen < yClose ? yOpen : yClose);
      buf.bodyHeight[slot] = fillSpan(
        yOpen < yClose ? yOpen : yClose,
        yOpen < yClose ? yClose : yOpen,
      );
      // Ordered by PIXEL, not by price: under §2.1 inversion Y(high) is below Y(low), and
      // assuming otherwise makes fillSpan negative, which the 1px floor then hides as a
      // wickless candle rather than as an error.
      const yWickTop = yHigh < yLow ? yHigh : yLow;
      const yWickBottom = yHigh < yLow ? yLow : yHigh;
      buf.wickTop[slot] = snapFill(yWickTop);
      buf.wickHeight[slot] = fillSpan(yWickTop, yWickBottom);

      if (volumeScale !== null) {
        const top = snapFill(volumeScale.y(bar.v));
        buf.volumeTop[slot] = top;
        buf.volumeHeight[slot] = Math.max(1, volumeBottom - top);
      }

      if (bar.c >= bar.o) {
        buf.up[upCount] = slot;
        upCount++;
      } else {
        buf.down[downCount] = slot;
        downCount++;
      }
      count++;
    }
    buf.upCount = upCount;
    buf.downCount = downCount;
    if (count === 0) return;

    // --- paint --------------------------------------------------------------
    const plot = f.layout.plot;
    ctx.save();
    if (f.snapshot.series.state === 'stale') ctx.globalAlpha = f.theme.staleAlpha;
    ctx.beginPath();
    ctx.rect(plot.left, plot.top, plot.width, plot.height);
    ctx.clip();

    // The 1px wick sits on the body's centre column — that is precisely why §6
    // forces an odd body width.
    ctx.fillStyle = f.theme.upWick;
    for (let j = 0; j < upCount; j++) {
      const s = buf.up[j];
      ctx.fillRect(buf.centre[s], buf.wickTop[s], 1, buf.wickHeight[s]);
    }
    ctx.fillStyle = f.theme.downWick;
    for (let j = 0; j < downCount; j++) {
      const s = buf.down[j];
      ctx.fillRect(buf.centre[s], buf.wickTop[s], 1, buf.wickHeight[s]);
    }

    if (candle.mode === 'body') {
      const bw = candle.width;
      const half = candle.half;
      ctx.fillStyle = f.theme.upBody;
      for (let j = 0; j < upCount; j++) {
        const s = buf.up[j];
        ctx.fillRect(buf.centre[s] - half, buf.bodyTop[s], bw, buf.bodyHeight[s]);
      }
      ctx.fillStyle = f.theme.downBody;
      for (let j = 0; j < downCount; j++) {
        const s = buf.down[j];
        ctx.fillRect(buf.centre[s] - half, buf.bodyTop[s], bw, buf.bodyHeight[s]);
      }
    }
    ctx.restore();

    if (volumeScale === null || pane === null) return;

    ctx.save();
    if (f.snapshot.series.state === 'stale') ctx.globalAlpha = f.theme.staleAlpha;
    ctx.beginPath();
    ctx.rect(pane.left, pane.top, pane.width, pane.height);
    ctx.clip();
    // §9 column: x = X(i) - bw/2, w = bw — the same snapped centre as the body, so
    // columns line up with candles exactly.
    const vw = candle.width;
    const vhalf = candle.half;
    ctx.fillStyle = f.theme.upVolume;
    for (let j = 0; j < buf.upCount; j++) {
      const s = buf.up[j];
      ctx.fillRect(buf.centre[s] - vhalf, buf.volumeTop[s], vw, buf.volumeHeight[s]);
    }
    ctx.fillStyle = f.theme.downVolume;
    for (let j = 0; j < buf.downCount; j++) {
      const s = buf.down[j];
      ctx.fillRect(buf.centre[s] - vhalf, buf.volumeTop[s], vw, buf.volumeHeight[s]);
    }
    ctx.restore();
  }
}

export function createSeriesLayer(): SeriesLayer {
  return new CandleSeriesLayer();
}
