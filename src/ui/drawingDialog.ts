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
  const dialog = document.createElement('dialog');
  dialog.id = 'drawing-settings';
  dialog.className = 'sheet';
  host.append(dialog);

  let cancel: (() => void) | null = null;
  const close = (): void => {
    if (dialog.open) dialog.close();
  };
  dialog.addEventListener('cancel', () => {
    cancel?.();
  });

  return {
    open(request) {
      let style: DrawingStyle = request.style;
      const original = request.style;
      let reverted = false;

      cancel = () => {
        if (reverted) return;
        reverted = true;
        request.onCancel(original);
      };

      const patch = (change: Partial<DrawingStyle>): void => {
        style = { ...style, ...change };
        request.onApply(style);
      };

      const form = document.createElement('form');
      form.method = 'dialog';

      const heading = document.createElement('h2');
      heading.textContent = request.label;
      form.append(heading);

      const grid = document.createElement('div');
      grid.className = 'grid';

      const colorLabel = document.createElement('label');
      colorLabel.textContent = 'Colour';
      const color = document.createElement('input');
      color.type = 'color';
      color.id = 'drawing-color';
      color.value = style.color ?? TOKEN_SWATCH;
      color.addEventListener('input', () => {
        patch({ color: color.value });
      });
      colorLabel.append(color);

      const widthLabel = document.createElement('label');
      widthLabel.textContent = 'Width';
      const width = document.createElement('input');
      width.type = 'number';
      width.id = 'drawing-width';
      width.min = '1';
      width.max = '8';
      width.step = '0.5';
      width.value = String(style.lineWidth);
      width.addEventListener('input', () => {
        const value = Number(width.value);
        if (!Number.isFinite(value) || value < 1 || value > 8) return;
        patch({ lineWidth: value });
      });
      widthLabel.append(width);

      const dashLabelEl = document.createElement('label');
      dashLabelEl.textContent = 'Line style';
      const dash = document.createElement('select');
      dash.id = 'drawing-dash';
      for (const entry of DASHES) {
        const option = document.createElement('option');
        option.value = entry.label;
        option.textContent = entry.label;
        dash.append(option);
      }
      dash.value = dashLabel(style.dash);
      dash.addEventListener('change', () => {
        patch({ dash: (DASHES.find((d) => d.label === dash.value) ?? DASHES[0]).dash });
      });
      dashLabelEl.append(dash);

      const opacityLabel = document.createElement('label');
      opacityLabel.textContent = 'Opacity';
      const opacity = document.createElement('input');
      opacity.type = 'number';
      opacity.id = 'drawing-opacity';
      opacity.min = '0.1';
      opacity.max = '1';
      opacity.step = '0.05';
      opacity.value = String(style.opacity);
      opacity.addEventListener('input', () => {
        const value = Number(opacity.value);
        if (!Number.isFinite(value) || value < 0.1 || value > 1) return;
        patch({ opacity: value });
      });
      opacityLabel.append(opacity);

      const labelsLabel = document.createElement('label');
      labelsLabel.textContent = 'Show labels';
      const labels = document.createElement('input');
      labels.type = 'checkbox';
      labels.id = 'drawing-labels';
      labels.checked = style.showLabels;
      labels.addEventListener('change', () => {
        patch({ showLabels: labels.checked });
      });
      labelsLabel.append(labels);

      grid.append(colorLabel, widthLabel, dashLabelEl, opacityLabel, labelsLabel);
      form.append(grid);

      const footer = document.createElement('div');
      footer.className = 'row-end';

      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'tb';
      cancelButton.id = 'drawing-cancel';
      cancelButton.textContent = 'Cancel';
      cancelButton.addEventListener('click', () => {
        cancel?.();
        close();
      });

      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'tb primary';
      ok.id = 'drawing-ok';
      ok.textContent = 'Ok';
      ok.addEventListener('click', () => {
        reverted = true;
        close();
      });

      footer.append(cancelButton, ok);
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
