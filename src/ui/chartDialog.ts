/**
 * Chart settings (Phase 8.3).
 *
 * Presentation only: nothing here changes what is computed, so every field is applied
 * with `chart.updateSettings` and a repaint rather than by rebuilding the chart. That
 * distinction matters — the theme toggle DOES rebuild, and it costs the pan position,
 * the selection and the undo stack every time.
 */

import { checkboxField, colorField, createSheet, footer, numberField, sheetForm } from './sheet.js';

export interface ChartSettingsForm {
  readonly showGrid: boolean;
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
  const sheet = createSheet('chart-settings', host);

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
