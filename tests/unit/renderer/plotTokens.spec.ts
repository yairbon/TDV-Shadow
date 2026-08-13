/**
 * Every plot of an indicator has to be told apart from every other plot of that indicator.
 *
 * `resolveToken` falls back to `overlayLine` for a name it does not know, so an indicator
 * that invents a token silently paints that plot the same colour as its neighbour and
 * nothing fails. That is how Ichimoku shipped with the lagging span and the base line in
 * one colour: `TOKEN_LINE_NEGATIVE` and `TOKEN_LINE_ALT` are the same string, and two
 * lines meaning opposite ends of the chart were drawn identically.
 *
 * This walks the whole registry rather than naming indicators, so the next one to plot
 * three lines is covered before it is written.
 */

import { describe, expect, it } from 'vitest';
import { computeIndicator, INDICATOR_IDS, INDICATORS } from '../../../src/indicators/registry.js';
import { resolveToken } from '../../../src/renderer/layers/annotationsLayer.js';
import { DARK_THEME, LIGHT_THEME } from '../../../src/renderer/theme.js';
import { makeBars } from './fixtures.js';

const BARS = makeBars(200);

describe('indicator plot colours', () => {
  it('gives every plot of an indicator a colour distinct from its siblings', () => {
    for (const id of INDICATOR_IDS) {
      const result = computeIndicator(id, BARS, {});
      // Bands are the deliberate exception: an upper and a lower edge of one envelope are
      // the same thing seen twice, and TradingView draws them alike too.
      const lines = result.plots.filter((plot) => plot.style !== 'band');
      const colors = lines.map((plot) => resolveToken(DARK_THEME, plot.colorToken));
      expect(new Set(colors).size, `${id} reuses a colour across its plots`).toBe(colors.length);
    }
  });

  it('resolves every token an indicator actually names', () => {
    // The fallback makes an unknown token indistinguishable from `overlayLine` at a
    // glance. Naming one and getting the fallback is always a mistake, so require that
    // every token in the registry is one the renderer knows by name.
    const known = new Set<string>();
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      for (const token of ['overlayLine', 'indicatorLineAlt', 'indicatorLineThird',
        'indicatorBand', 'indicatorHistogram', 'indicatorProfile', 'upVolume']) {
        known.add(token);
        expect(resolveToken(theme, token)).not.toBe('');
      }
    }
    for (const id of INDICATOR_IDS) {
      for (const plot of computeIndicator(id, BARS, {}).plots) {
        expect(known.has(plot.colorToken), `${id}.${plot.key} names ${plot.colorToken}`).toBe(true);
      }
    }
  });

  it('keeps the distinct tokens distinct in both themes', () => {
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      const line = resolveToken(theme, 'overlayLine');
      const alt = resolveToken(theme, 'indicatorLineAlt');
      const third = resolveToken(theme, 'indicatorLineThird');
      expect(new Set([line, alt, third]).size).toBe(3);
    }
  });

  it('has an indicator registered for every id it advertises', () => {
    // The MCP server validates against this list; an id in it with no definition would
    // pass validation and then throw at compute time.
    for (const id of INDICATOR_IDS) expect(INDICATORS[id]).toBeDefined();
  });
});
