/**
 * ChartType -> transform. The registry is the only place the app looks up a type, so
 * adding a type means adding it here and nowhere else.
 *
 * The 1:1 types share `passthrough` and differ only in draw style: the bars really are
 * the input bars, and the style tells the series layer whether to paint candles, a
 * polyline, an area, columns and so on. Duplicating a transform per style would invite
 * them to drift apart for no benefit.
 */

import type { Bar } from '../data/types.js';
import { heikinAshiTransform } from './heikinAshi.js';
import { kagiTransform, lineBreakTransform, pointAndFigureTransform } from './lineBreak.js';
import { rangeTransform, renkoTransform } from './renko.js';
import { passthrough } from './shared.js';
import type {
  ChartType,
  ChartTypeParams,
  ChartTypeTransform,
  DerivedSeries,
  DrawStyle,
} from './types.js';

function oneToOne(type: ChartType, style: DrawStyle): ChartTypeTransform {
  return {
    type,
    style,
    preservesIndexSpace: true,
    transform: (bars: readonly Bar[], params: ChartTypeParams): DerivedSeries =>
      Object.freeze<DerivedSeries>({
        type,
        style,
        bars: Object.freeze(passthrough(bars)),
        preservesIndexSpace: true,
        baseline:
          style === 'baseline'
            ? (params.baselinePrice ?? (bars.length > 0 ? bars[0].c : 0))
            : null,
      }),
  };
}

const TRANSFORMS: Readonly<Record<ChartType, ChartTypeTransform>> = Object.freeze({
  candles: oneToOne('candles', 'candle'),
  'hollow-candles': oneToOne('hollow-candles', 'hollow'),
  bars: oneToOne('bars', 'bar'),
  line: oneToOne('line', 'polyline'),
  area: oneToOne('area', 'area'),
  baseline: oneToOne('baseline', 'baseline'),
  'step-line': oneToOne('step-line', 'step'),
  columns: oneToOne('columns', 'column'),
  'heikin-ashi': heikinAshiTransform,
  renko: renkoTransform,
  kagi: kagiTransform,
  'point-and-figure': pointAndFigureTransform,
  'line-break': lineBreakTransform,
  range: rangeTransform,
});

export function getChartTransform(type: ChartType): ChartTypeTransform {
  return TRANSFORMS[type];
}

export function applyChartType(
  type: ChartType,
  bars: readonly Bar[],
  params: ChartTypeParams = {},
): DerivedSeries {
  return TRANSFORMS[type].transform(bars, params);
}

export { TRANSFORMS };
