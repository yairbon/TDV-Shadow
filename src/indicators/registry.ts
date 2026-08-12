/** IndicatorId -> definition. The only lookup point, so adding one means adding it here. */

import type { Bar } from '../data/types.js';
import { atrIndicator, bollingerIndicator, macdIndicator, rsiIndicator, stochasticIndicator } from './oscillators.js';
import { emaIndicator, vwapIndicator, wmaIndicator } from './movingAverages.js';
import { adxIndicator } from './adx.js';
import { cciIndicator } from './cci.js';
import { donchianIndicator } from './donchian.js';
import { keltnerIndicator } from './keltner.js';
import { obvIndicator } from './obv.js';
import { psarIndicator } from './psar.js';
import { smaIndicator } from './sma.js';
import { supertrendIndicator } from './supertrend.js';
import { volumeIndicator, volumeProfileIndicator } from './volume.js';
import { williamsRIndicator } from './williamsR.js';
import type { IndicatorDefinition, IndicatorId, IndicatorParams, IndicatorResult } from './types.js';

const INDICATORS: Readonly<Record<IndicatorId, IndicatorDefinition>> = Object.freeze({
  sma: smaIndicator,
  ema: emaIndicator,
  wma: wmaIndicator,
  vwap: vwapIndicator,
  bollinger: bollingerIndicator,
  macd: macdIndicator,
  rsi: rsiIndicator,
  stochastic: stochasticIndicator,
  atr: atrIndicator,
  volume: volumeIndicator,
  'volume-profile': volumeProfileIndicator,
  obv: obvIndicator,
  cci: cciIndicator,
  'williams-r': williamsRIndicator,
  donchian: donchianIndicator,
  keltner: keltnerIndicator,
  adx: adxIndicator,
  supertrend: supertrendIndicator,
  psar: psarIndicator,
});

export function getIndicator(id: IndicatorId): IndicatorDefinition {
  return INDICATORS[id];
}

/** Computes with the definition's defaults filled in for anything not supplied. */
export function computeIndicator(
  id: IndicatorId,
  bars: readonly Bar[],
  params: IndicatorParams = {},
): IndicatorResult {
  const definition = INDICATORS[id];
  return definition.compute(bars, { ...definition.defaults, ...params });
}

export const INDICATOR_IDS = Object.freeze(Object.keys(INDICATORS) as IndicatorId[]);
export { INDICATORS };
