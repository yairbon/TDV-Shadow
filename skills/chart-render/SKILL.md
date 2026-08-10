---
name: chart-render
description: Rules for drawing candlestick/OHLCV charts on HTML5 Canvas in TDV-Shadow — frame lifecycle, pixel snapping, candle geometry, axis ticks, and visual regression checks. Use when writing or reviewing anything under src/renderer, adding a chart series or overlay, fixing blurry/overlapping/misaligned candles, or touching coordinate transforms.
---

<!-- TRUNCATION-CRITICAL: the first 40 lines are load-bearing. Never append above them. -->

# Chart Rendering — Non-Negotiable Rules

1. **Candlesticks must never overlap horizontally.** Body width `bw` must satisfy
   `bw + 1 <= barSpacing`, i.e. `bw = max(1, floor(barSpacing * 0.8))` clamped so at least
   1 device-independent pixel of gap remains between adjacent bodies. When `barSpacing < 3`,
   stop drawing bodies and draw a 1px vertical high–low line instead.
2. **Clear the canvas context precisely on every `requestAnimationFrame`.** Each layer calls
   `ctx.clearRect(0, 0, cssWidth, cssHeight)` (in CSS-pixel space, after the DPR transform is
   set) as the first statement of its draw pass. Never rely on `canvas.width = canvas.width`.
3. **One rAF per frame, one draw entrypoint.** Events and WebSocket messages set state and
   call `scheduler.invalidate(mask)`. They never draw. Reentrant `requestAnimationFrame`
   inside a draw pass is a bug.
4. **Never mutate bar data while drawing.** The renderer reads a frozen snapshot taken at
   frame start. If data arrives mid-frame it applies to the next frame.
5. **Snap strokes to half-pixels.** For a 1px line: `Math.round(x) + 0.5`. For fills
   (candle bodies, volume columns): `Math.round` both edges, never fractional. Unsnapped
   coordinates are the single most common cause of blurry charts.
6. **Handle DPR once, at the top.** `canvas.width = round(cssW * dpr)`,
   `canvas.height = round(cssH * dpr)`, then `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`.
   All downstream math is in CSS pixels. Never multiply by `dpr` again anywhere else.
7. **No DOM for chart primitives.** No elements for candles, ticks, gridlines, crosshair,
   or tooltips-inside-plot. Canvas only. (Root `CLAUDE.md` mandate #1.)
8. **Clip every series to the plot rect** with `ctx.save(); ctx.beginPath();
   ctx.rect(plot.left, plot.top, plot.width, plot.height); ctx.clip();` … `ctx.restore();`
   Nothing may bleed into the axis gutters.
9. **Degenerate ranges must not divide by zero.** If `priceMax === priceMin`, expand the
   range to `p ± max(|p| * 1e-4, 1e-8)` before building the transform.
10. **The coordinate transforms in `docs/RENDER_ALGORITHMS.md` are normative.** Import them
    from `src/renderer/scale/`; never inline a re-derived formula in a draw call.

---

## Frame lifecycle

```
invalidate(mask) -> if !scheduled: scheduled = rAF(frame)
frame(t):
  scheduled = false
  snapshot   = store.snapshot()          // frozen, O(1)
  layout     = computeLayout(viewportPx) // plot rect, gutters
  priceScale = makePriceScale(snapshot.visibleRange, layout.plot)
  timeScale  = makeTimeScale(snapshot.scroll, layout.plot)
  for layer of dirtyLayers(mask):
    layer.clear(); layer.draw(snapshot, priceScale, timeScale, layout)
```

Layers, back to front, each its own stacked `<canvas>`:
`grid` → `series` (candles + volume) → `overlay` (indicators, drawings) → `crosshair`.
Only `crosshair` redraws on pointer move. Panning dirties `grid|series|overlay`.

## Candle geometry

Given bar `i` with `{o,h,l,c}` and price scale `Y`:

```
xc  = round(timeScale.x(i))                 // bar center, CSS px
bw  = candleBodyWidth(barSpacing)           // see rule 1; force ODD so the wick centers
half= (bw - 1) / 2
yO  = Y(o); yC = Y(c); yH = Y(h); yL = Y(l)
bodyTop    = round(min(yO, yC))
bodyBottom = round(max(yO, yC))
bodyH      = max(1, bodyBottom - bodyTop)   // doji -> 1px line, never 0
wick: fillRect(xc - 0.5|0, round(yH), 1, max(1, round(yL) - round(yH)))
body: fillRect(xc - half, bodyTop, bw, bodyH)
```

Draw wicks and bodies in **two batched passes grouped by color** (all up-wicks, all
down-wicks, all up-bodies, all down-bodies) to minimise `fillStyle` state changes.
Use `fillRect`, not `strokeRect` + `beginPath` per candle.

## Axes

- Price ticks: nice-number algorithm in `docs/RENDER_ALGORITHMS.md` §4. Minimum tick spacing
  is the label line-height × 1.6 — drop ticks rather than let labels touch.
- Time ticks: pick the coarsest unit whose spacing ≥ 60px, and emphasise boundary bars
  (day/month/year change) with a stronger label. Never label every bar.
- Labels are drawn with `ctx.fillText`, `textBaseline = "middle"`, at snapped integer y.

## Performance budget

- Frame budget 8ms at 5,000 visible bars. Slice the visible index range **before** the draw
  loop — never iterate the full series and `continue`.
- No allocation inside the draw loop: no `map`/`filter`/object literals per bar. Reuse
  preallocated typed arrays for the geometry pass.
- `ctx.save()/restore()` at most a few times per layer, not per bar.

## Visual regression

Every renderer change ships with a Playwright screenshot check
(`tests/visual/*.spec.ts`, harness in `tests/visual/README.md`):

1. Serve the dev build, load a deterministic fixture (fixed seed, fixed viewport
   1280×720, `deviceScaleFactor: 2`, animations disabled, clock frozen).
2. Wait for the `chart:rendered` event (do not `waitForTimeout`).
3. `expect(page.locator('#chart')).toHaveScreenshot()` with `maxDiffPixelRatio: 0.001`.
4. Assert spatial integrity programmatically as well as visually: read back the geometry
   the renderer used and assert (a) no two candle bodies share an x-pixel, (b) every drawn
   pixel lies inside the plot rect, (c) `document.body.scrollWidth <= clientWidth`.

Baselines live in `tests/visual/__screenshots__/`. A diff is a failure until a human
approves the new baseline — never auto-update.
