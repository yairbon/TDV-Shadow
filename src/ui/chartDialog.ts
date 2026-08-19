/**
 * Chart settings (Phase 8.3).
 *
 * Presentation only: nothing here changes what is computed, so every field is applied
 * with `chart.updateSettings` and a repaint rather than by rebuilding the chart. That
 * distinction matters — the theme toggle DOES rebuild, and it costs the pan position,
 * the selection and the undo stack every time.
 */

import { TIME_ZONES } from '../renderer/scale/timezone.js';
import {
  checkboxField,
  colorField,
  createSheet,
  footer,
  numberField,
  selectField,
  sheetForm,
} from './sheet.js';

export interface ChartSettingsForm {
  readonly showGrid: boolean;
  readonly showPreviousClose: boolean;
  /** IANA zone for time labels. */
  readonly timeZone: string;
  readonly pricePrecision: number;
  /** Empty bars kept to the right of the newest one. */
  readonly rightMargin: number;
  readonly upColor: string;
  readonly downColor: string;
}

export interface ChartDialog {
  open(request: {
    readonly settings: ChartSettingsForm;
    readonly defaults: ChartSettingsForm;
    readonly onApply: (settings: ChartSettingsForm) => void;
    readonly onCancel: (settings: ChartSettingsForm) => void;
  }): void;
  close(): void;
  dispose(): void;
}

export function createChartDialog(host: HTMLElement = document.body): ChartDialog {
  // Not 'chart-settings': the toolbar gear button already owns that id, and two elements
  // sharing one id is invalid HTML — `document.querySelector('#chart-settings')` then
  // returns whichever happens to come first in document order, which is the button only
  // because this dialog is appended to <body> at runtime. A test had already learned to
  // hedge with a two-branch selector rather than trust it.
  const sheet = createSheet('chart-settings-sheet', host);

  return {
    open(request) {
      let current = request.settings;
      const original = request.settings;

      const patch = (change: Partial<ChartSettingsForm>): void => {
        current = { ...current, ...change };
        request.onApply(current);
      };

      const form = sheetForm('Chart settings');
      const grid = document.createElement('div');
      grid.className = 'grid';
      grid.append(
        checkboxField({
          label: 'Gridlines',
          id: 'chart-grid',
          value: current.showGrid,
          onChange: (showGrid) => {
            patch({ showGrid });
          },
        }),
        checkboxField({
          label: 'Previous close',
          id: 'chart-prev-close',
          value: current.showPreviousClose,
          onChange: (showPreviousClose) => {
            patch({ showPreviousClose });
          },
        }),
        numberField({
          label: 'Price decimals',
          id: 'chart-precision',
          min: 0,
          max: 8,
          step: 1,
          value: current.pricePrecision,
          onChange: (pricePrecision) => {
            patch({ pricePrecision });
          },
        }),
        numberField({
          label: 'Right margin (bars)',
          id: 'chart-margin',
          min: 0,
          max: 80,
          step: 1,
          value: current.rightMargin,
          onChange: (rightMargin) => {
            patch({ rightMargin });
          },
        }),
        selectField({
          label: 'Timezone',
          id: 'chart-timezone',
          options: [...TIME_ZONES],
          value: current.timeZone,
          onChange: (timeZone) => {
            patch({ timeZone });
          },
        }),
        colorField({
          label: 'Up colour',
          id: 'chart-up',
          value: current.upColor,
          onChange: (upColor) => {
            patch({ upColor });
          },
        }),
        colorField({
          label: 'Down colour',
          id: 'chart-down',
          value: current.downColor,
          onChange: (downColor) => {
            patch({ downColor });
          },
        }),
      );
      form.append(grid);

      form.append(
        footer([
          {
            label: 'Defaults',
            id: 'chart-reset',
            onSelect: () => {
              current = request.defaults;
              request.onApply(current);
              sheet.commit();
            },
          },
          {
            label: 'Cancel',
            id: 'chart-cancel',
            onSelect: () => {
              sheet.close();
            },
          },
          {
            label: 'Ok',
            id: 'chart-ok',
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
