/**
 * Theme token names used by indicator `PlotSpec.colorToken`.
 *
 * Indicators never hard-code a colour (`types.ts` PlotSpec). They name a token and the
 * renderer resolves it against the active `Theme`. Tokens that already exist on `Theme`
 * are reused verbatim; the rest are indicator-specific names the renderer is expected to
 * resolve, falling back to `overlayLine` for any token it does not know.
 */

/** Primary line of a single-line indicator. Exists on `Theme`. */
export const TOKEN_LINE = 'overlayLine';
/** Second line of a two-line indicator (MACD signal, stochastic %D). */
export const TOKEN_LINE_ALT = 'indicatorLineAlt';
/** Outer edges of a band (Bollinger upper/lower). */
export const TOKEN_BAND = 'indicatorBand';
/** Signed histogram (MACD). */
export const TOKEN_HISTOGRAM = 'indicatorHistogram';
/** Volume columns. Exists on `Theme`; the renderer tints per bar direction. */
export const TOKEN_VOLUME = 'upVolume';
/** Horizontal volume-profile rows. */
export const TOKEN_PROFILE = 'indicatorProfile';
