/**
 * Colours, typography and density constants for the canvas renderer.
 *
 * Pure data — no canvas calls, no element access. Layers read every colour and
 * every spacing constant from here so that a theme swap is one object swap plus a
 * full `invalidate(DirtyFlags.All)`.
 */

export interface Typography {
  readonly fontFamily: string;
  readonly fontSize: number;
  /**
   * Label line box in CSS px. Drives the tick budget in RENDER_ALGORITHMS §8
   * (`T = P.h / (labelLineHeight * 1.6)`).
   */
  readonly lineHeight: number;
  /** Precomposed `ctx.font` string so no template literal is built per frame. */
  readonly font: string;
}

export interface Density {
  /** Width of the right-hand price axis gutter, CSS px. */
  readonly priceGutterWidth: number;
  /** Height of the bottom time axis gutter, CSS px. */
  readonly timeGutterHeight: number;
  /** Share of the content height given to the volume pane. 0 disables the pane. */
  readonly volumePaneFraction: number;
  /** Blank CSS px between the price pane and the volume pane. */
  readonly paneGap: number;
  /** Below this the volume pane is dropped rather than squeezed. */
  readonly minPlotHeight: number;
  /** Coarsen the time unit until ticks are at least this far apart (SKILL "Axes"). */
  readonly minTimeTickSpacing: number;
  readonly labelPaddingX: number;
  readonly labelPaddingY: number;
  /** Half-height of the boxed crosshair axis labels. */
  readonly axisLabelHeight: number;
}

export interface Theme {
  readonly name: string;
  readonly background: string;
  readonly gridLine: string;
  readonly axisLine: string;
  readonly axisText: string;
  readonly axisTextStrong: string;
  readonly upBody: string;
  readonly downBody: string;
  readonly upWick: string;
  readonly downWick: string;
  readonly upVolume: string;
  readonly downVolume: string;
  readonly crosshairLine: string;
  readonly crosshairDash: readonly number[];
  readonly labelBackground: string;
  readonly labelText: string;
  readonly overlayLine: string;
  /** `globalAlpha` used while a series is `stale` — dim it rather than lie about it. */
  readonly staleAlpha: number;
  readonly typography: Typography;
  readonly density: Density;
}

const FONT_STACK =
  'ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const TYPOGRAPHY: Typography = Object.freeze({
  fontFamily: FONT_STACK,
  fontSize: 11,
  lineHeight: 14,
  font: `11px ${FONT_STACK}`,
});

const DENSITY: Density = Object.freeze({
  priceGutterWidth: 64,
  timeGutterHeight: 24,
  volumePaneFraction: 0.22,
  paneGap: 6,
  minPlotHeight: 80,
  minTimeTickSpacing: 60,
  labelPaddingX: 6,
  labelPaddingY: 3,
  axisLabelHeight: 16,
});

export const DARK_THEME: Theme = Object.freeze({
  name: 'dark',
  background: '#131722',
  gridLine: '#1f2733',
  axisLine: '#2a3341',
  axisText: '#8a94a6',
  axisTextStrong: '#c3cbd8',
  upBody: '#26a69a',
  downBody: '#ef5350',
  upWick: '#26a69a',
  downWick: '#ef5350',
  upVolume: '#1c6b64',
  downVolume: '#8f3634',
  crosshairLine: '#758696',
  crosshairDash: Object.freeze([4, 4]),
  labelBackground: '#3d4655',
  labelText: '#e6ebf2',
  overlayLine: '#e0a33c',
  staleAlpha: 0.45,
  typography: TYPOGRAPHY,
  density: DENSITY,
});

export const LIGHT_THEME: Theme = Object.freeze({
  name: 'light',
  background: '#ffffff',
  gridLine: '#eceff3',
  axisLine: '#d6dae0',
  axisText: '#6b7684',
  axisTextStrong: '#2a2f3a',
  upBody: '#089981',
  downBody: '#f23645',
  upWick: '#089981',
  downWick: '#f23645',
  upVolume: '#a3ddd2',
  downVolume: '#f6b8bd',
  crosshairLine: '#9598a1',
  crosshairDash: Object.freeze([4, 4]),
  labelBackground: '#3d4655',
  labelText: '#ffffff',
  overlayLine: '#c77c15',
  staleAlpha: 0.45,
  typography: TYPOGRAPHY,
  density: DENSITY,
});
