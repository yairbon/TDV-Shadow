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

const SOURCES: readonly IndicatorParams['source'][] = [
  'close',
  'open',
  'high',
  'low',
  'hl2',
  'hlc3',
  'ohlc4',
];

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
  const dialog = document.createElement('dialog');
  dialog.id = 'indicator-settings';
  dialog.className = 'sheet';
  host.append(dialog);

  let cancel: (() => void) | null = null;

  const close = (): void => {
    if (dialog.open) dialog.close();
  };

  // A dialog dismissed with Escape fires `cancel`, and the browser closes it for us. The
  // revert has to hang off that event rather than off the Cancel button alone, or Escape
  // would silently keep every live-previewed edit.
  dialog.addEventListener('cancel', () => {
    cancel?.();
  });

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
      const asParams = (): IndicatorParams => Object.fromEntries(params);
      const asStyles = (): PlotStyles => Object.fromEntries(styles);

      let reverted = false;
      cancel = () => {
        if (reverted) return;
        reverted = true;
        request.onCancel(original);
      };

      const apply = (): void => {
        request.onApply({ params: asParams(), styles: asStyles() });
      };

      const form = document.createElement('form');
      form.method = 'dialog';

      const heading = document.createElement('h2');
      heading.textContent = definition.label;
      form.append(heading);

      // ---- inputs, one per declared default ----
      const inputs = document.createElement('div');
      inputs.className = 'grid';
      for (const name of Object.keys(definition.defaults)) {
        const spec = FIELDS[name];
        if (spec === undefined) continue;

        const label = document.createElement('label');
        label.textContent = spec.label;

        if (spec.kind === 'source') {
          const select = document.createElement('select');
          select.dataset['param'] = name;
          for (const source of SOURCES) {
            const option = document.createElement('option');
            option.value = source ?? 'close';
            option.textContent = source ?? 'close';
            select.append(option);
          }
          select.value = String(params.get(name) ?? 'close');
          select.addEventListener('change', () => {
            params.set(name, select.value);
            apply();
          });
          label.append(select);
        } else {
          const input = document.createElement('input');
          input.type = 'number';
          input.dataset['param'] = name;
          input.min = String(spec.min);
          input.max = String(spec.max);
          input.step = String(spec.step);
          input.value = String(params.get(name) ?? spec.min);
          input.addEventListener('input', () => {
            const value = Number(input.value);
            // Out-of-range or half-typed input is ignored rather than clamped: clamping
            // fights the user mid-keystroke, turning "50" into "5" then "50".
            if (!Number.isFinite(value) || value < spec.min || value > spec.max) return;
            params.set(name, spec.step >= 1 ? Math.round(value) : value);
            apply();
          });
          label.append(input);
        }
        inputs.append(label);
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

          const color = document.createElement('input');
          color.type = 'color';
          color.dataset['plotColor'] = plot.key;
          color.value = styles.get(plot.key)?.color ?? FALLBACK_COLOR;
          color.addEventListener('input', () => {
            styles.set(plot.key, { ...styles.get(plot.key), color: color.value });
            apply();
          });

          const width = document.createElement('input');
          width.type = 'number';
          width.dataset['plotWidth'] = plot.key;
          width.min = '1';
          width.max = '8';
          width.step = '0.5';
          width.value = String(styles.get(plot.key)?.lineWidth ?? 1.5);
          width.addEventListener('input', () => {
            const value = Number(width.value);
            if (!Number.isFinite(value) || value < 1 || value > 8) return;
            styles.set(plot.key, { ...styles.get(plot.key), lineWidth: value });
            apply();
          });

          const dash = document.createElement('select');
          dash.dataset['plotDash'] = plot.key;
          for (const entry of DASHES) {
            const option = document.createElement('option');
            option.value = entry.label;
            option.textContent = entry.label;
            dash.append(option);
          }
          dash.value = dashLabel(styles.get(plot.key)?.dash);
          dash.addEventListener('change', () => {
            const entry = DASHES.find((d) => d.label === dash.value) ?? DASHES[0];
            styles.set(plot.key, { ...styles.get(plot.key), dash: entry.dash });
            apply();
          });

          row.append(name, color, width, dash);
          form.append(row);
        }
      }

      // ---- footer ----
      const footer = document.createElement('div');
      footer.className = 'row-end';

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'tb';
      reset.id = 'indicator-reset';
      reset.textContent = 'Defaults';
      reset.addEventListener('click', () => {
        params.clear();
        for (const [key, value] of Object.entries(definition.defaults)) {
          if (typeof value === 'number' || typeof value === 'string') params.set(key, value);
        }
        styles.clear();
        apply();
        // Nothing left to revert to: Defaults IS the commit.
        reverted = true;
        close();
      });

      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'tb';
      cancelButton.id = 'indicator-cancel';
      cancelButton.textContent = 'Cancel';
      cancelButton.addEventListener('click', () => {
        cancel?.();
        close();
      });

      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'tb primary';
      ok.id = 'indicator-ok';
      ok.textContent = 'Ok';
      ok.addEventListener('click', () => {
        // Committing means there is nothing left to revert.
        reverted = true;
        close();
      });

      footer.append(reset, cancelButton, ok);
      form.append(footer);

      dialog.replaceChildren(form);
      dialog.showModal();
    },

    close,
    dispose() {
      close();
      dialog.remove();
    },
  };
}
