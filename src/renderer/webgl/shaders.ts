/**
 * GLSL for the instanced candle renderer (RENDER_ALGORITHMS §11).
 *
 * The transform lives in the vertex shader so pan and zoom only rewrite two uniforms —
 * the instance buffer of raw (index, o, h, l, c, v) tuples is uploaded once. That is the
 * whole point of the WebGL path; doing the transform on the CPU would keep the per-frame
 * cost the Canvas2D path already has.
 *
 * Every equation here mirrors the normative CPU implementation:
 *   x centre  §5:  X(i) = P.l + P.w - (k - i) * s
 *   y         §2:  Y(p) = P.t + (pMax - p) * P.h / (pMax - pMin)
 *   snapping  §7:  fills snap with round(); a rect is round(b) - round(a), min 1px
 *
 * Canvas2D remains the reference implementation. Any disagreement beyond one device
 * pixel is a WebGL bug, and `tests/visual/webgl.spec.ts` is what proves it.
 */

export const PASS_WICK = 0;
export const PASS_BODY = 1;
export const PASS_VOLUME = 2;

export const VERTEX_SHADER = `#version 300 es
precision highp float;

// Unit quad, 0..1 on both axes; 6 vertices, two triangles.
in vec2 aCorner;

// Per-instance bar: index, open, high, low, close, volume.
in float aIndex;
in float aOpen;
in float aHigh;
in float aLow;
in float aClose;
in float aVolume;

uniform vec4 uPlot;        // left, top, width, height (CSS px)
uniform vec4 uVolumeRect;  // left, top, width, height (CSS px); width 0 = no pane
uniform vec2 uViewport;    // CSS px
uniform float uBarSpacing; // s
uniform float uScroll;     // k
uniform float uPriceMin;   // pMin (already guarded against a degenerate range)
uniform float uPriceMax;   // pMax
uniform float uVolumeMax;  // vMax
uniform float uBodyWidth;  // bw, odd, >= 1
uniform int uPass;         // 0 wick, 1 body, 2 volume
uniform int uScaleMode;    // 0 linear (§2), 1 logarithmic (§3)
uniform float uLogMin;     // ln(pMin) after the §3 guard, log space
uniform float uLogMax;     // ln(pMax) after the §3 guard, log space
uniform int uInvert;       // 1 = §2.1 reflection about the plot mid-line

out float vDirection;      // >0 when close >= open

// §7: fills snap with round(). GLSL floor(v + 0.5) matches Math.round for v >= 0,
// and the plot is never at a negative CSS coordinate.
float snapFill(float v) {
  return floor(v + 0.5);
}

// Price -> CSS pixel.
//   §2 linear:  Y(p)    = P.t + (pMax - p) * P.h / (pMax - pMin)
//   §3 log:     Ylog(p) = P.t + (ln pMax - ln p) * P.h / (ln pMax - ln pMin)
// Percent mode is the log geometry re-based on p0 for LABELS only, so it takes the
// same branch — the pixels are identical, only the axis text differs.
// §2/§3 upright map. GLSL has no hoisting: this must be declared before priceToY calls
// it, or the shader fails to compile and the GL chart silently never paints.
float uprightY(float p) {
  if (uScaleMode == 1) {
    // §3 drops bars at p <= 0 rather than clamping; the clamp here only keeps log()
    // defined for a value the CPU has already excluded from the visible range.
    float lp = log(max(p, 1e-12));
    float mLog = uPlot.w / (uLogMax - uLogMin);
    return uPlot.y + (uLogMax - lp) * mLog;
  }
  float m = uPlot.w / (uPriceMax - uPriceMin);
  return uPlot.y + (uPriceMax - p) * m;
}

// §2.1: reflect the finished map about the plot's mid-line so log, percent and the
// degenerate-range guard invert for free and cannot drift from the CPU scale.
float priceToY(float p) {
  float y = uprightY(p);
  return uInvert == 1 ? 2.0 * uPlot.y + uPlot.w - y : y;
}

void main() {
  // §5 bar centre.
  float xc = uPlot.x + uPlot.z - (uScroll - aIndex) * uBarSpacing;

  float x0;
  float x1;
  float y0;
  float y1;

  if (uPass == 2) {
    // §9 volume column: shares the time scale, own vertical transform.
    float halfW = floor(uBodyWidth * 0.5);
    x0 = snapFill(xc - halfW);
    x1 = x0 + max(uBodyWidth, 1.0);
    float h = uVolumeMax <= 0.0 ? 0.0 : (aVolume / uVolumeMax) * uVolumeRect.w;
    y1 = uVolumeRect.y + uVolumeRect.w;
    y0 = snapFill(y1 - h);
    y1 = snapFill(y1);
    y1 = max(y1, y0 + 1.0);
  } else if (uPass == 1) {
    // §6 body: spans bw columns centred on xc; height floored at 1 so a doji shows.
    float halfW = floor(uBodyWidth * 0.5);
    x0 = snapFill(xc - halfW);
    x1 = x0 + uBodyWidth;
    float yOpen = priceToY(aOpen);
    float yClose = priceToY(aClose);
    y0 = snapFill(min(yOpen, yClose));
    y1 = snapFill(max(yOpen, yClose));
    y1 = max(y1, y0 + 1.0);
  } else {
    // Wick: 1px column on the bar centre, high to low.
    x0 = snapFill(xc);
    x1 = x0 + 1.0;
    // min/max rather than assuming high is above low: under §2.1 inversion the two swap,
    // and ordering them by price would collapse every wick to the 1px floor.
    float yHigh = snapFill(priceToY(aHigh));
    float yLow = snapFill(priceToY(aLow));
    y0 = min(yHigh, yLow);
    y1 = max(yHigh, yLow);
    y1 = max(y1, y0 + 1.0);
  }

  vec2 posCss = vec2(mix(x0, x1, aCorner.x), mix(y0, y1, aCorner.y));

  // CSS px -> clip space. Y is inverted because Y(p) grows downward.
  vec2 clip = vec2(
    (posCss.x / uViewport.x) * 2.0 - 1.0,
    1.0 - (posCss.y / uViewport.y) * 2.0
  );

  vDirection = aClose >= aOpen ? 1.0 : -1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in float vDirection;
uniform vec4 uColorUp;
uniform vec4 uColorDown;
out vec4 outColor;

void main() {
  outColor = vDirection > 0.0 ? uColorUp : uColorDown;
}
`;
