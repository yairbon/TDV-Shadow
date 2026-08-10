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
s' = clamp(s * z, sMin, sMax)                 // z > 1 zooms in; sMin = 0.5, sMax = 120
k' = ia + (P.l + P.w - xa) / s'
```

Pan by `dx` pixels: `k' = k - dx / s'` (drag right → dx > 0 → reveals older bars).

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

## 11. WebGL variant (Phase 2+, behind a flag)

Same equations; the transform moves to the vertex shader as an orthographic matrix so the
CPU uploads raw `(index, price)` pairs once and only the uniforms change on pan/zoom.

```
// clip-space, y-down source data
u_scale  = vec2( 2*s / P.w,        -2 / (pMax - pMin) * (P.h / viewportH) )
u_offset = vec2( 1 - 2*(k*s)/P.w,   1 - 2*(P.t/viewportH) + 2*pMax/(pMax - pMin) * (P.h/viewportH) )
gl_Position = vec4(a_pos * u_scale + u_offset, 0, 1)
```

Geometry: one instanced quad per candle body (6 verts, per-instance
`[index, openPrice, closePrice, highPrice, lowPrice]`), wicks as a second instanced pass.
Pixel snapping is done in the fragment/vertex stage by rounding to
`floor(x * dpr) / dpr + 0.5 / dpr` — the 2D-canvas snapping rules above still govern the
*intent*. The Canvas2D path stays the reference implementation; any WebGL output that
disagrees with it by more than 1 device pixel is a WebGL bug.
