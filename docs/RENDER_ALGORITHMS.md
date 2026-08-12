# Render Algorithms — Normative Coordinate Math

Authoritative source for every coordinate transform in TDV-Shadow. Code implements this
file; this file is not a description of the code. The block between the MATH-CRITICAL
markers is re-injected verbatim by the PreCompact hook.

Symbols used throughout:

| Symbol | Meaning |
| --- | --- |
| `P.l, P.t, P.w, P.h` | plot rect (CSS px): left, top, width, height — axis gutters excluded |
| `pMin, pMax` | visible price range (after padding) |
| `s` | `barSpacing`, CSS px per bar, `s > 0` |
| `r` | `rightOffset`, fractional bars of empty space kept right of the last bar |
| `n` | bar count in the series |
| `k` | fractional bar index currently at the plot's right edge = `n - 1 + r` |
| `dpr` | `window.devicePixelRatio` |

<!-- MATH-CRITICAL:BEGIN -->

## 1. Device pixel ratio (applied once, in `surface.ts`)

```
canvas.width  = Math.round(cssW * dpr)
canvas.height = Math.round(cssH * dpr)
canvas.style.width  = cssW + "px"
canvas.style.height = cssH + "px"
ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
```

After this call all math is in CSS pixels. `dpr` appears nowhere else.

## 2. Price → Y (linear scale)

Domain `[pMin, pMax]` maps to the plot rect with Y inverted (high price = small y):

```
m      = P.h / (pMax - pMin)                 // px per price unit
Y(p)   = P.t + (pMax - p) * m
Y⁻¹(y) = pMax - (y - P.t) / m
```

Invariants:
- `Y(pMax) = P.t`, `Y(pMin) = P.t + P.h`. Verify both in unit tests.
- Guard degenerate range first: if `pMax - pMin < ε` (ε = `max(|pMax| * 1e-9, 1e-12)`),
  set `pMax += d`, `pMin -= d` with `d = max(|pMax| * 1e-4, 1e-8)`.
- `Y` is total and monotone-decreasing. It is never clamped — clipping is the drawing
  layer's job (`ctx.clip` to the plot rect), because clamping would flatten wicks onto
  the plot edge and lie about the data.

## 2.1 Inverted price axis

Inversion is a reflection of the finished map about the plot's horizontal mid-line, not a
second set of equations:

```
M(y)      = 2 * P.t + P.h - y          // involution: M(M(y)) = y
Yinv(p)   = M(Y(p))
Yinv⁻¹(y) = Y⁻¹(M(y))
```

Because `M` is applied to the result, §3 (log), percent mode and the §2 degenerate-range
guard invert unchanged and cannot drift out of agreement with the upright case. `Yinv`
maps `pMin → P.t` and `pMax → P.t + P.h` — the exact opposite of §2, as required.

Consequences for the layers:
- Anything that assumed "high is above low" must order by pixel, not by price. In the GL
  shader the wick rect takes `min`/`max` of the two projected Y values; ordering them by
  price collapses every wick to the 1px floor when inverted.
- Volume columns are **not** inverted: they grow from the bottom of their own pane, which
  has no price meaning.

## 3. Price → Y (logarithmic scale)

```
L(p)     = Math.log(p)                        // require p > 0; bars with p <= 0 are dropped
mLog     = P.h / (L(pMax) - L(pMin))
Ylog(p)  = P.t + (L(pMax) - L(p)) * mLog
Ylog⁻¹(y)= Math.exp(L(pMax) - (y - P.t) / mLog)
```

Percent-scale mode is the log scale re-based on the first visible bar's close `p₀`:
displayed value = `(p / p₀ - 1) * 100`, geometry unchanged.

## 4. Autoscale of the visible price range

Over visible bars `[i₀, i₁]`:

```
rawMin = min(low[i])   over i in [i₀, i₁]  (including visible overlay/indicator extents)
rawMax = max(high[i])  over i in [i₀, i₁]
pad    = (rawMax - rawMin) * 0.1            // 10% top+bottom breathing room
pMin   = rawMin - pad
pMax   = rawMax + pad
```

Recompute only when the visible index range or the underlying bars change — never per frame.

## 5. Bar index → X (time scale)

Index space is uniform: sessions/gaps consume no width, so `x` is linear in the *index*,
not in wall-clock time.

```
k       = scrollPosition                     // fractional index at the RIGHT edge of the plot
X(i)    = P.l + P.w - (k - i) * s            // bar CENTER, CSS px
X⁻¹(x)  = k - (P.l + P.w - x) / s            // fractional bar index
```

Visible index range (inclusive, clamped to `[0, n-1]`):

```
i₀ = max(0,   Math.floor(X⁻¹(P.l)))
i₁ = min(n-1, Math.ceil (X⁻¹(P.l + P.w)))
```

Zoom about an anchor pixel `xa` (cursor position), keeping the bar under the cursor fixed:

```
ia = X⁻¹(xa)                                  // before
s' = clamp(s * z, sMin, sMax)                 // z > 1 zooms in; sMin = 0.01, sMax = 120
k' = ia + (P.l + P.w - xa) / s'
```

Pan by `dx` pixels: `k' = k - dx / s'` (drag right → dx > 0 → reveals older bars).

### 5.1 Level of detail (`sMin` below one pixel per bar)

`sMin` is 0.01, so a 100k-bar history fits on a 1200px plot. Below **one CSS pixel per
bar** the series layer must aggregate before drawing:

```
column(i) = round(X(i))                       // the pixel a bar lands on
per column: o = first bar's o, c = last bar's c, h = max h, l = min l, v = sum v
```

That is a resampled bar, so a column is a real OHLC bar for a wider period.

Two properties this must have, and both are asserted in tests:
- Buckets are formed by **pixel column**, not by a fixed bar stride. A fixed stride makes
  bucket boundaries drift against the pixel grid while panning, and the series shimmers.
- The aggregate **must** be taken. Drawing every bar into the same column is not merely
  slow: the later bar paints over the earlier one, so the column shows the LAST bar in it
  rather than the range of all of them, and every spike disappears.

`X(i)` is affine and therefore monotone in `i`, so the aggregation is one pass with no
sorting.

## 6. Candle body width (no-overlap invariant)

```
bw0 = Math.floor(s * 0.8)
bw  = Math.max(1, Math.min(bw0, Math.floor(s) - 1))   // enforce >= 1px gap
if (bw % 2 === 0) bw -= 1                              // odd width centers the 1px wick
if (bw < 1) bw = 1
if (s < 3) -> draw high/low line only, bw = 1
```

Invariant asserted in tests: for all adjacent i, `X(i+1) - bw/2 >= X(i) + bw/2 + 1`.

## 7. Pixel snapping

```
snapLine(v) = Math.round(v) + 0.5      // for 1px strokes: gridlines, crosshair, axis rules
snapFill(v) = Math.round(v)            // for fills: candle bodies, volume columns
```

Height/width of a fill is `snapFill(b) - snapFill(a)`, floored at 1 — a rect computed as
`round(b - a)` drifts and produces 0px doji.

## 8. Nice price ticks

Target ~`P.h / (labelLineHeight * 1.6)` ticks; let `T` be that count (min 2).

```
raw  = (pMax - pMin) / T
mag  = Math.pow(10, Math.floor(Math.log10(raw)))
norm = raw / mag                        // in [1, 10)
mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10
step = mult * mag
first= Math.ceil(pMin / step) * step
ticks: p = first, first + step, … while p <= pMax
```

Label decimals = `max(0, -Math.floor(Math.log10(step)))`, capped by the instrument's
`pricePrecision`. On a log scale, generate ticks per decade with the same mantissa set.

## 9. Volume subpanel

Separate transform sharing the time scale:

```
vMax   = max(volume[i]) over visible i        (0 -> skip the pane)
Yv(v)  = V.t + V.h - (v / vMax) * V.h
column: x = X(i) - bw/2, y = snapFill(Yv(v)), w = bw, h = max(1, V.h - (Yv(v) - V.t))
```

## 10. Crosshair snapping

Snap x to the nearest bar center: `i = Math.round(X⁻¹(xMouse))`, draw at `snapLine(X(i))`.
Y follows the raw pointer; the price label shows `Y⁻¹(yMouse)` rounded to `pricePrecision`.

<!-- MATH-CRITICAL:END -->

## 11. WebGL variant (Phase 4, behind the `?gl=1` flag)

Implemented in `src/renderer/webgl/`. Same equations; the transform moves to the vertex
shader so the CPU uploads raw tuples once and only uniforms change on pan/zoom.

**This section was rewritten to match the shipped shader.** The earlier draft expressed
the transform as a fused `u_scale`/`u_offset` pair folding the price map, the viewport
normalisation and the DPR into two vectors. That is algebraically equivalent but it
inlined a re-derivation of §2 and §5 that could drift from them silently. The shader now
evaluates §5 and §2 verbatim in CSS pixels and normalises to clip space as a final step,
so a change to the canonical transforms cannot leave the GPU path behind:

```glsl
// §5 bar centre, CSS px
float xc = uPlot.x + uPlot.z - (uScroll - aIndex) * uBarSpacing;

// §2 price -> CSS px (linear only; log/percent stay on Canvas2D)
float m = uPlot.w / (uPriceMax - uPriceMin);
float y  = uPlot.y + (uPriceMax - p) * m;

// §7 snapping: fills round; GLSL floor(v + 0.5) == Math.round for v >= 0
float snapFill(float v) { return floor(v + 0.5); }

// CSS px -> clip space, Y inverted because Y(p) grows downward
clip = vec2((x / uViewport.x) * 2.0 - 1.0, 1.0 - (y / uViewport.y) * 2.0);
```

Geometry: one unit quad (6 verts) drawn with `drawArraysInstanced`, per-instance
`[index, open, high, low, close, volume]` (6 floats, stride 24B). Three passes over the
same buffer, selected by `uPass`: wicks, then bodies over them, then volume columns.
WebGL2 has no `baseInstance`, so the visible slice is a byte offset into the instance
buffer. `gl.scissor` is the GPU equivalent of `ctx.clip()` for SKILL rule 8, and the
instance buffer is re-uploaded only when the snapshot revision changes.

Scope: the **series layer only**. Grid, axes, overlays and crosshair stay Canvas2D in
both modes, and the linear price scale is the only supported mode — `supportsMode()`
gates it and the layer warns rather than silently drawing a linear chart for a log view.

The Canvas2D path stays the reference implementation; any WebGL output that disagrees
with it by more than 1 device pixel is a WebGL bug. `tests/visual/webgl.spec.ts` enforces
that by comparing painted-column coverage and per-column vertical extents between the two
renderers, rather than comparing raw pixels — rasteriser antialiasing legitimately differs
and would make an exact-pixel diff a false alarm.
