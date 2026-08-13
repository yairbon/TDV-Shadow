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

/**
 * Directional pair — a plot that means "buying pressure" against one that means "selling
 * pressure" (+DI / −DI, an up-trend stop against a down-trend stop).
 *
 * These deliberately alias token names the renderer already resolves (`upVolume` and
 * `indicatorLineAlt` → the theme's up and down body colours) rather than introducing new
 * names: an unknown token falls back to `overlayLine`, which would silently paint the two
 * halves of a directional pair the same colour.
 */
export const TOKEN_LINE_POSITIVE = 'upVolume';
export const TOKEN_LINE_NEGATIVE = 'indicatorLineAlt';

/**
 * A third line, distinct from both `TOKEN_LINE` and `TOKEN_LINE_ALT`.
 *
 * Ichimoku is the reason: it plots five lines at once, and with only two general-purpose
 * line tokens the lagging span came out the same colour as the base line — two things
 * that mean opposite ends of the same chart, drawn identically.
 */
export const TOKEN_LINE_THIRD = 'indicatorLineThird';
