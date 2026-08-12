/**
 * Indicator settings (Phase 8.1).
 *
 * The form is DERIVED, not hand-written per indicator: the fields come from the keys of
 * the indicator definition's `defaults`, and the style rows come from the plots the
 * indicator actually declares. Adding a twelfth indicator therefore gets a correct
 * settings dialog for free, and — more importantly — a dialog can never offer a field the
 * indicator ignores, which is how "the period box does nothing" bugs happen.
 *
 * The one thing that IS hand-written is the input spec per parameter name (range, step,
 * label), because "period must be a positive integer" is knowledge the type
 * `IndicatorParams` cannot carry.
 */

import { getIndicator } from '../indicators/registry.js';
import type { IndicatorId, IndicatorParams, PlotSpec } from '../indicators/types.js';
import type { PlotStyles, PlotStyleOverride } from '../renderer/layers/annotationsLayer.js';
import { colorField, createSheet, footer, numberField, selectField, sheetForm } from './sheet.js';

export interface IndicatorSettings {
  readonly params: IndicatorParams;
  readonly styles: PlotStyles;
}

export interface IndicatorDialog {
  /**
   * Opens for one live indicator. `onApply` fires on every edit — live preview is the
   * point; a dialog you must close to see the effect makes tuning a period guesswork.
   */
  open(request: {
    readonly id: IndicatorId;
    readonly handleId: string;
    readonly params: IndicatorParams;
    readonly styles: PlotStyles;
    readonly plots: readonly PlotSpec[];
    readonly onApply: (settings: IndicatorSettings) => void;
    /** Called once, with the state as it was on open, if the user cancels. */
    readonly onCancel: (settings: IndicatorSettings) => void;
  }): void;
  close(): void;
  dispose(): void;
}

interface NumberSpec {
  readonly kind: 'number';
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

interface SourceSpec {
  readonly kind: 'source';
  readonly label: string;
}

type FieldSpec = NumberSpec | SourceSpec;

/**
 * How each parameter is edited. Keyed by the name used in `IndicatorParams`, so a
 * definition that declares a default this table does not know about is skipped rather
 * than rendered as an uncontrolled text box.
 */
const FIELDS: Readonly<Record<string, FieldSpec | undefined>> = {
  period: { kind: 'number', label: 'Length', min: 1, max: 5000, step: 1 },
  fastPeriod: { kind: 'number', label: 'Fast length', min: 1, max: 5000, step: 1 },
  slowPeriod: { kind: 'number', label: 'Slow length', min: 1, max: 5000, step: 1 },
  signalPeriod: { kind: 'number', label: 'Signal smoothing', min: 1, max: 5000, step: 1 },
  stdDev: { kind: 'number', label: 'Std deviations', min: 0.1, max: 10, step: 0.1 },
  buckets: { kind: 'number', label: 'Rows', min: 4, max: 400, step: 1 },
  valueAreaPercent: { kind: 'number', label: 'Value area %', min: 1, max: 100, step: 1 },
  source: { kind: 'source', label: 'Source' },
};

const SOURCES: readonly string[] = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];

const DASHES: readonly { readonly label: string; readonly dash: readonly number[] }[] = [
  { label: 'Solid', dash: [] },
  { label: 'Dashed', dash: [6, 4] },
  { label: 'Dotted', dash: [2, 3] },
];

/** Default swatch when the user has not chosen a colour yet. */
const FALLBACK_COLOR = '#2962ff';

const dashLabel = (dash: readonly number[] | undefined): string => {
  if (dash === undefined || dash.length === 0) return 'Solid';
  return dash[0] > 3 ? 'Dashed' : 'Dotted';
};

export function createIndicatorDialog(host: HTMLElement = document.body): IndicatorDialog {
  const sheet = createSheet('indicator-settings', host);

  return {
    open(request) {
      const definition = getIndicator(request.id);
      // Maps rather than plain records: `noUncheckedIndexedAccess` is off, so a record
      // index types as present-and-defined and every `?.` on it reads as dead code to the
      // linter while being very much alive at runtime. Copies, too — live preview must
      // never mutate the caller's frozen state in place.
      const params = new Map<string, number | string>();
      for (const [key, value] of Object.entries({ ...definition.defaults, ...request.params })) {
        if (typeof value === 'number' || typeof value === 'string') params.set(key, value);
      }
      const styles = new Map<string, PlotStyleOverride>(Object.entries(request.styles));
      const original: IndicatorSettings = { params: request.params, styles: request.styles };

      const apply = (): void => {
        request.onApply({
          params: Object.fromEntries(params),
          styles: Object.fromEntries(styles),
        });
      };

      const form = sheetForm(definition.label);

      // ---- inputs, one per declared default ----
      const inputs = document.createElement('div');
      inputs.className = 'grid';
      for (const name of Object.keys(definition.defaults)) {
        const spec = FIELDS[name];
        if (spec === undefined) continue;

        if (spec.kind === 'source') {
          inputs.append(
            selectField({
              label: spec.label,
              dataset: { param: name },
              options: SOURCES,
              value: String(params.get(name) ?? 'close'),
              onChange: (value) => {
                params.set(name, value);
                apply();
              },
            }),
          );
          continue;
        }
        inputs.append(
          numberField({
            label: spec.label,
            dataset: { param: name },
            min: spec.min,
            max: spec.max,
            step: spec.step,
            value: Number(params.get(name) ?? spec.min),
            onChange: (value) => {
              params.set(name, value);
              apply();
            },
          }),
        );
      }
      form.append(inputs);

      // ---- one style row per declared plot ----
      if (request.plots.length > 0) {
        const styleHeading = document.createElement('h3');
        styleHeading.textContent = 'Style';
        form.append(styleHeading);

        for (const plot of request.plots) {
          const row = document.createElement('div');
          row.className = 'style-row';
          row.dataset['plot'] = plot.key;

          const name = document.createElement('span');
          name.className = 'nm';
          name.textContent = plot.label;

          row.append(
            name,
            colorField({
              label: '',
              dataset: { plotColor: plot.key },
              value: styles.get(plot.key)?.color ?? FALLBACK_COLOR,
              onChange: (color) => {
                styles.set(plot.key, { ...styles.get(plot.key), color });
                apply();
              },
            }),
            numberField({
              label: '',
              dataset: { plotWidth: plot.key },
              min: 1,
              max: 8,
              step: 0.5,
              value: styles.get(plot.key)?.lineWidth ?? 1.5,
              onChange: (lineWidth) => {
                styles.set(plot.key, { ...styles.get(plot.key), lineWidth });
                apply();
              },
            }),
            selectField({
              label: '',
              dataset: { plotDash: plot.key },
              options: DASHES.map((d) => d.label),
              value: dashLabel(styles.get(plot.key)?.dash),
              onChange: (label) => {
                const entry = DASHES.find((d) => d.label === label) ?? DASHES[0];
                styles.set(plot.key, { ...styles.get(plot.key), dash: entry.dash });
                apply();
              },
            }),
          );
          form.append(row);
        }
      }

      form.append(
        footer([
          {
            label: 'Defaults',
            id: 'indicator-reset',
            onSelect: () => {
              params.clear();
              for (const [key, value] of Object.entries(definition.defaults)) {
                if (typeof value === 'number' || typeof value === 'string') params.set(key, value);
              }
              styles.clear();
              apply();
              // Nothing left to revert to: Defaults IS the commit.
              sheet.commit();
            },
          },
          {
            label: 'Cancel',
            id: 'indicator-cancel',
            onSelect: () => {
              sheet.close();
            },
          },
          {
            label: 'Ok',
            id: 'indicator-ok',
            primary: true,
            onSelect: () => {
              sheet.commit();
            },
          },
        ]),
      );

      sheet.show(form, () => {
        request.onCancel(original);
      });
    },

    close() {
      sheet.close();
    },
    dispose() {
      sheet.dispose();
    },
  };
}
