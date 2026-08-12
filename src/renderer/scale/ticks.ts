/**
 * Axis ticks.
 *
 * Price ticks are the nice-number algorithm of RENDER_ALGORITHMS §8, transcribed
 * term for term. Time ticks coarsen the unit until labels are at least
 * `minSpacingPx` apart (SKILL "Axes"), and never label every bar.
 *
 * Calendar maths here is UTC-only and Date-free on the per-bar path: the month/year
 * period key is computed arithmetically so the boundary scan over 5,000 visible bars
 * allocates nothing. `Date` is used only to format the handful of emitted labels.
 */

import { asBarIndex, asPixel, type Bar, type BarIndex, type Pixel, type Price } from '../../data/types.js';
import { asPrice } from '../../data/types.js';
import type { PriceScale } from './priceScale.js';
import type { TimeScale, VisibleRange } from './timeScale.js';
import { offsetMinutes, shiftToZone, type TimeZone } from './timezone.js';

// ---------------------------------------------------------------------------
// Price ticks (§8)
// ---------------------------------------------------------------------------

/** §8 mantissa set. */
export const NICE_MANTISSAS: readonly number[] = Object.freeze([1, 2, 2.5, 5, 10]);

/** Ticks that fit without labels touching: `P.h / (labelLineHeight * 1.6)`, min 2. */
export function targetTickCount(plotHeight: number, labelLineHeight: number): number {
  const budget = plotHeight / (labelLineHeight * 1.6);
  return Math.max(2, Math.floor(budget));
}

/**
 * §8 step selection:
 *
 *     mag  = 10^floor(log10(raw));  norm = raw / mag
 *     mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10
 *     step = mult * mag
 */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

export function priceTickStep(min: number, max: number, targetCount: number): number {
  return niceStep((max - min) / targetCount);
}

/** §8 label decimals: `max(0, -floor(log10(step)))`, capped by the instrument precision. */
export function tickDecimals(step: number, pricePrecision: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return Math.max(0, pricePrecision);
  const wanted = Math.max(0, -Math.floor(Math.log10(step)));
  return Math.min(wanted, Math.max(0, pricePrecision));
}

export function formatPrice(value: number, decimals: number): string {
  return value.toFixed(Math.min(Math.max(decimals, 0), 20));
}

export interface PriceTick {
  readonly price: Price;
  /** Unsnapped Y; the layer snaps it (§7). */
  readonly y: Pixel;
  readonly label: string;
}

/** Hard ceiling so a pathological range can never spin the tick loop. */
const MAX_TICKS = 512;

/**
 * Linear ticks: `first = ceil(pMin / step) * step`, then `first + j * step` while
 * `p <= pMax`. Multiplying out beats accumulating `p += step`, which drifts.
 */
function linearPriceTicks(scale: PriceScale, decimalsCap: number, target: number): PriceTick[] {
  const pMin: number = scale.min;
  const pMax: number = scale.max;
  const step = priceTickStep(pMin, pMax, target);
  const out: PriceTick[] = [];
  if (step <= 0) return out;

  const decimals = tickDecimals(step, decimalsCap);
  const first = Math.ceil(pMin / step) * step;
  const slack = step * 1e-9;
  for (let j = 0; j < MAX_TICKS; j++) {
    const p = first + j * step;
    if (p > pMax + slack) break;
    const price = asPrice(p);
    out.push({ price, y: scale.y(price), label: formatPrice(p, decimals) });
  }
  return out;
}

/**
 * Log ticks: the same mantissa set once per decade (§8), thinned so no two labels
 * land closer than the label line box.
 */
function logPriceTicks(scale: PriceScale, decimalsCap: number, minGapPx: number): PriceTick[] {
  const pMin: number = scale.min;
  const pMax: number = scale.max;
  const out: PriceTick[] = [];
  if (!(pMin > 0) || !(pMax > pMin)) return out;

  const firstDecade = Math.floor(Math.log10(pMin));
  const lastDecade = Math.ceil(Math.log10(pMax));
  let lastY = Number.NEGATIVE_INFINITY;

  for (let d = firstDecade; d <= lastDecade && out.length < MAX_TICKS; d++) {
    const mag = Math.pow(10, d);
    for (const mantissa of NICE_MANTISSAS) {
      if (mantissa === 10) continue; // 10 * mag is the next decade's 1 * mag
      const p = mantissa * mag;
      if (p < pMin || p > pMax) continue;
      const price = asPrice(p);
      const y: number = scale.y(price);
      if (Math.abs(y - lastY) < minGapPx) continue;
      lastY = y;
      out.push({
        price,
        y: asPixel(y),
        label: formatPrice(p, tickDecimals(mag, decimalsCap)),
      });
    }
  }
  return out;
}

/** Drops ticks that would sit closer than `minGapPx`, keeping the first of each pair. */
function thin(ticks: readonly PriceTick[], minGapPx: number): PriceTick[] {
  const out: PriceTick[] = [];
  let lastY = Number.NEGATIVE_INFINITY;
  for (const tick of ticks) {
    if (Math.abs(tick.y - lastY) < minGapPx) continue;
    lastY = tick.y;
    out.push(tick);
  }
  return out;
}

/**
 * Price ticks for the current scale. `pricePrecision` caps label decimals; the
 * label line box drives both the target count and the log-scale thinning.
 */
export function priceTicks(
  scale: PriceScale,
  labelLineHeight: number,
  pricePrecision: number,
): PriceTick[] {
  const target = targetTickCount(scale.height, labelLineHeight);
  if (scale.mode === 'linear') return linearPriceTicks(scale, pricePrecision, target);

  const perDecade = logPriceTicks(scale, pricePrecision, labelLineHeight * 1.6);
  if (perDecade.length >= 2) return perDecade;
  // The visible window spans less than a decade, so §8's mantissa-per-decade set has
  // nothing to offer (a 95..105 view would get a single gridline at 100). Fall back
  // to nice-number steps, still positioned through the log transform so the
  // gridlines land where a log axis puts them.
  return thin(linearPriceTicks(scale, pricePrecision, target), labelLineHeight);
}

/** Percent-mode axis labels re-base the same geometry on `p0` (§3). */
export function formatPercent(scale: PriceScale, price: Price): string {
  const pct = scale.percentOf(price);
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Time ticks
// ---------------------------------------------------------------------------

const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;
const MS_WEEK = 604_800_000;
/** 1970-01-05, the first Monday of the epoch — the origin for week keys. */
const MONDAY_EPOCH = 4 * MS_DAY;

export type TimeUnitKind = 'time' | 'day' | 'week' | 'month' | 'year';

export interface TimeUnit {
  readonly id: string;
  /** Nominal length, used only to estimate on-screen spacing. */
  readonly ms: number;
  readonly kind: TimeUnitKind;
}

/** Ascending. Month/year lengths are nominal; boundaries use the calendar key. */
export const TIME_UNITS: readonly TimeUnit[] = Object.freeze([
  Object.freeze({ id: '1m', ms: MS_MINUTE, kind: 'time' as const }),
  Object.freeze({ id: '5m', ms: 5 * MS_MINUTE, kind: 'time' as const }),
  Object.freeze({ id: '15m', ms: 15 * MS_MINUTE, kind: 'time' as const }),
  Object.freeze({ id: '30m', ms: 30 * MS_MINUTE, kind: 'time' as const }),
  Object.freeze({ id: '1h', ms: MS_HOUR, kind: 'time' as const }),
  Object.freeze({ id: '2h', ms: 2 * MS_HOUR, kind: 'time' as const }),
  Object.freeze({ id: '4h', ms: 4 * MS_HOUR, kind: 'time' as const }),
  Object.freeze({ id: '6h', ms: 6 * MS_HOUR, kind: 'time' as const }),
  Object.freeze({ id: '12h', ms: 12 * MS_HOUR, kind: 'time' as const }),
  Object.freeze({ id: '1d', ms: MS_DAY, kind: 'day' as const }),
  Object.freeze({ id: '1w', ms: MS_WEEK, kind: 'week' as const }),
  Object.freeze({ id: '1mo', ms: 30 * MS_DAY, kind: 'month' as const }),
  Object.freeze({ id: '1y', ms: 365 * MS_DAY, kind: 'year' as const }),
]);

/**
 * Coarsen the unit until its on-screen spacing reaches `minSpacingPx`.
 *
 * Spacing is `(unit.ms / tfMs) * barSpacing` because index space is uniform (§5).
 * Units finer than the timeframe are never candidates. If nothing is coarse enough
 * (a single bar wider than a year of screen space) the coarsest unit is returned.
 */
export function chooseTimeUnit(
  barSpacing: number,
  tfMs: number,
  minSpacingPx: number,
): TimeUnit {
  const coarsest = TIME_UNITS[TIME_UNITS.length - 1];
  if (!(tfMs > 0) || !(barSpacing > 0)) return coarsest;
  for (const unit of TIME_UNITS) {
    if (unit.ms < tfMs) continue;
    if ((unit.ms / tfMs) * barSpacing >= minSpacingPx) return unit;
  }
  return coarsest;
}

/** Days since the epoch, UTC. Integer, no Date. */
function utcDayKey(t: number): number {
  return Math.floor(t / MS_DAY);
}

/**
 * `year * 12 + month0`, UTC, allocation-free (civil-from-days). Used as the
 * month/year period key on the per-bar scan.
 */
function utcMonthKey(t: number): number {
  const z = utcDayKey(t) + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp + (mp < 10 ? 3 : -9); // 1..12
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return year * 12 + (month - 1);
}

function periodKey(t: number, unit: TimeUnit): number {
  switch (unit.kind) {
    case 'time':
      return Math.floor(t / unit.ms);
    case 'day':
      return utcDayKey(t);
    case 'week':
      return Math.floor((t - MONDAY_EPOCH) / MS_WEEK);
    case 'month':
      return utcMonthKey(t);
    case 'year':
      return Math.floor(utcMonthKey(t) / 12);
  }
}

const MONTH_NAMES: readonly string[] = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

export type TimeLabelStyle = 'time' | 'day' | 'month' | 'year';

/** UTC-only formatting. Called once per emitted tick, never per bar. */
export function formatTimeLabel(t: number, style: TimeLabelStyle): string {
  // `t` is expected to be already shifted into the display zone by the caller — the
  // formatters below are, and remain, pure UTC readers.
  const d = new Date(t);
  switch (style) {
    case 'time':
      return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    case 'day':
      return String(d.getUTCDate());
    case 'month':
      return MONTH_NAMES[d.getUTCMonth()];
    case 'year':
      return String(d.getUTCFullYear());
  }
}

/**
 * Full timestamp for the crosshair's time tag (§10).
 *
 * The DATA stays UTC epoch ms (mandate #5); `zone` shifts the printed text only, and the
 * shift happens here rather than anywhere upstream.
 */
export function formatCrosshairTime(t: number, tfMs: number, zone: TimeZone = 'UTC'): string {
  const d = new Date(shiftToZone(t, zone));
  const day = `${pad2(d.getUTCDate())} ${MONTH_NAMES[d.getUTCMonth()]}`;
  if (tfMs >= MS_DAY) return `${day} ${String(d.getUTCFullYear())}`;
  return `${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export interface TimeTick {
  readonly index: BarIndex;
  /** Unsnapped bar-centre X; the layer snaps it (§7). */
  readonly x: Pixel;
  readonly label: string;
  /** Day/month/year boundary — drawn with the stronger label colour. */
  readonly major: boolean;
}

function labelStyleFor(unit: TimeUnit, monthChanged: boolean, yearChanged: boolean): TimeLabelStyle {
  if (yearChanged) return 'year';
  if (unit.kind === 'year') return 'year';
  if (unit.kind === 'month') return 'month';
  if (monthChanged) return 'month';
  if (unit.kind === 'day' || unit.kind === 'week') return 'day';
  return 'time';
}

/**
 * Boundary bars of the chosen unit, within the visible range.
 *
 * A bar is a tick when its period key differs from the previous bar's — so gaps and
 * session breaks cannot produce a tick on a bar that is not actually a boundary.
 * Ticks closer than `minSpacingPx` are dropped, except that a major tick displaces
 * the minor one it collides with.
 */
/**
 * Ticks plus the session separators for the same range (10.2).
 *
 * Both come out of one pass because both are boundary tests over the same bars, and at
 * 100k visible bars a second scan is a second few milliseconds.
 */
export interface TimeAxis {
  readonly ticks: readonly TimeTick[];
  /**
   * Unsnapped X of each calendar-day boundary, in the display timezone. Empty for daily
   * and coarser timeframes, where every bar is already its own day.
   */
  readonly sessionBreaks: readonly number[];
}

export function timeTicks(
  bars: readonly Bar[],
  range: VisibleRange,
  scale: TimeScale,
  tfMs: number,
  minSpacingPx: number,
  zone: TimeZone = 'UTC',
): TimeAxis {
  const out: TimeTick[] = [];
  const breaks: number[] = [];
  if (range.isEmpty || bars.length === 0) return { ticks: out, sessionBreaks: breaks };

  const unit = chooseTimeUnit(scale.barSpacing, tfMs, minSpacingPx);
  const from: number = range.from;
  const to: number = range.to;

  // A zone's offset is constant across a screenful of bars except across a DST switch.
  // Resolving it once when it is constant keeps a Map lookup and a string concatenation
  // out of a loop that runs over every visible bar; the per-bar path is only taken on the
  // rare range that straddles a transition, where it is required for correctness.
  const startOffset = offsetMinutes(zone, bars[from].t);
  const endOffset = offsetMinutes(zone, bars[to].t);
  const constantShift = startOffset === endOffset ? startOffset * 60_000 : null;
  const shift = (raw: number): number =>
    constantShift === null ? shiftToZone(raw, zone) : raw + constantShift;

  // Session breaks are a calendar-day notion, so they only mean something intraday.
  const wantBreaks = tfMs < MS_DAY;
  let lastX = Number.NEGATIVE_INFINITY;

  for (let i = from; i <= to; i++) {
    if (i === 0) continue; // no predecessor: cannot prove it is a boundary
    const t: number = shift(bars[i].t);
    const prev: number = shift(bars[i - 1].t);

    if (wantBreaks && utcDayKey(t) !== utcDayKey(prev)) breaks.push(scale.x(asBarIndex(i)));
    if (periodKey(t, unit) === periodKey(prev, unit)) continue;

    const monthChanged = utcMonthKey(t) !== utcMonthKey(prev);
    const yearChanged = Math.floor(utcMonthKey(t) / 12) !== Math.floor(utcMonthKey(prev) / 12);
    const major = monthChanged || yearChanged;
    const x: number = scale.x(asBarIndex(i));

    if (x - lastX < minSpacingPx) {
      const previous = out.length > 0 ? out[out.length - 1] : null;
      if (previous === null || !major || previous.major) continue;
      out.pop(); // a month/year boundary outranks the minor tick it collides with
    }

    lastX = x;
    out.push({
      index: asBarIndex(i),
      x: asPixel(x),
      label: formatTimeLabel(t, labelStyleFor(unit, monthChanged, yearChanged)),
      major,
    });
  }

  return { ticks: out, sessionBreaks: breaks };
}
