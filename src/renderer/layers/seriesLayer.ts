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
import { aggregateByColumn, shouldAggregate } from '../scale/lod.js';
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
    const volumeBottom = pane === null ? 0 : snapFill(rectBottom(pane));

    // --- geometry pass ------------------------------------------------------
    // Below 1px per bar there are more bars than columns, so aggregate first (§5.1).
    // Without this the later bar in a column simply paints over the earlier one and the
    // chart shows the last bar per pixel instead of the range of all of them.
    const lod = shouldAggregate(f.timeScale.barSpacing, f.visible.count)
      ? // §5: X(i) = P.l + P.w - (k - i) * s, which is x0 + i*s with
        // x0 = P.l + P.w - k*s. Passed as the affine pair so the inner loop has no call.
        aggregateByColumn(
          bars,
          from,
          to,
          f.layout.plot.left + f.layout.plot.width - f.timeScale.scrollPosition * f.timeScale.barSpacing,
          f.timeScale.barSpacing,
        )
      : null;
    const last = lod === null ? to : lod.length - 1;
    const start = lod === null ? from : 0;
    buf.ensure(last - start + 1);

    // The volume scale must be built from what is actually DRAWN. A column's volume is
    // the SUM of its bars, so scaling by the per-bar maximum would send every aggregated
    // column far past the top of the pane.
    let vMax = 0;
    if (pane !== null) {
      if (lod === null) {
        vMax = maxVolume(bars, f.visible.from, f.visible.to);
      } else {
        for (const column of lod) if (column.v > vMax) vMax = column.v;
      }
    }
    const volumeScale = pane === null ? null : makeVolumeScale(pane, vMax);

    let count = 0;
    let upCount = 0;
    let downCount = 0;
    for (let i = start; i <= last; i++) {
      const bar = lod === null ? bars[i] : lod[i];
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
      buf.centre[slot] = lod === null ? snapFill(f.timeScale.x(asBarIndex(i))) : lod[i].x;
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
