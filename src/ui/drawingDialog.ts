/**
 * Drawing style editor (Phase 8.2).
 *
 * Every field here edits a property that already existed on `DrawingStyle` and that
 * nothing painted: colour, width, dash, opacity and label visibility were stored,
 * serialised and round-tripped through JSON while the renderer drew every drawing with
 * the same hard-coded 1.5px overlay line. This dialog is the front half of making that
 * block real; `drawDrawings` is the back half.
 */

import type { DrawingStyle } from '../drawings/types.js';
import {
  checkboxField,
  colorField,
  createSheet,
  footer,
  numberField,
  selectField,
  sheetForm,
} from './sheet.js';

export interface DrawingDialog {
  /** `onApply` fires per edit — live preview, same contract as the indicator sheet. */
  open(request: {
    readonly id: string;
    readonly label: string;
    readonly style: DrawingStyle;
    readonly onApply: (style: DrawingStyle) => void;
    readonly onCancel: (style: DrawingStyle) => void;
  }): void;
  close(): void;
  dispose(): void;
}

const DASHES: readonly { readonly label: string; readonly dash: readonly number[] }[] = [
  { label: 'Solid', dash: [] },
  { label: 'Dashed', dash: [6, 4] },
  { label: 'Dotted', dash: [2, 3] },
];

const dashLabel = (dash: readonly number[]): string => {
  if (dash.length === 0) return 'Solid';
  return dash[0] > 3 ? 'Dashed' : 'Dotted';
};

/**
 * Swatch shown when the drawing still carries a theme token rather than a chosen colour.
 * It matches the token's dark-theme value, so opening the dialog does not appear to
 * change the drawing before anything is edited.
 */
const TOKEN_SWATCH = '#2962ff';

export function createDrawingDialog(host: HTMLElement = document.body): DrawingDialog {
  const sheet = createSheet('drawing-settings', host);

  return {
    open(request) {
      let style: DrawingStyle = request.style;
      const original = request.style;

      const patch = (change: Partial<DrawingStyle>): void => {
        style = { ...style, ...change };
        request.onApply(style);
      };

      const form = sheetForm(request.label);
      const grid = document.createElement('div');
      grid.className = 'grid';
      grid.append(
        colorField({
          label: 'Colour',
          id: 'drawing-color',
          value: style.color ?? TOKEN_SWATCH,
          onChange: (color) => {
            patch({ color });
          },
        }),
        numberField({
          label: 'Width',
          id: 'drawing-width',
          min: 1,
          max: 8,
          step: 0.5,
          value: style.lineWidth,
          onChange: (lineWidth) => {
            patch({ lineWidth });
          },
        }),
        selectField({
          label: 'Line style',
          id: 'drawing-dash',
          options: DASHES.map((d) => d.label),
          value: dashLabel(style.dash),
          onChange: (label) => {
            patch({ dash: (DASHES.find((d) => d.label === label) ?? DASHES[0]).dash });
          },
        }),
        numberField({
          label: 'Opacity',
          id: 'drawing-opacity',
          min: 0.1,
          max: 1,
          step: 0.05,
          value: style.opacity,
          onChange: (opacity) => {
            patch({ opacity });
          },
        }),
        checkboxField({
          label: 'Show labels',
          id: 'drawing-labels',
          value: style.showLabels,
          onChange: (showLabels) => {
            patch({ showLabels });
          },
        }),
      );
      form.append(grid);

      form.append(
        footer([
          {
            label: 'Cancel',
            id: 'drawing-cancel',
            onSelect: () => {
              sheet.close();
            },
          },
          {
            label: 'Ok',
            id: 'drawing-ok',
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
