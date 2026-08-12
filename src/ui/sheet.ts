/**
 * Shared plumbing for the settings sheets (Phase 8).
 *
 * Three dialogs — indicator, drawing, chart — repeat the same two things, and one of them
 * is subtle enough to be worth writing once:
 *
 *   A sheet previews live, so dismissing it must REVERT. `<dialog>` closes itself on
 *   Escape and fires `cancel`, which the button handler never sees, so hanging the revert
 *   off Cancel alone silently commits every Escape. The revert also has to be idempotent,
 *   because Cancel both reverts and closes, and closing fires `cancel` again.
 *
 * The field builders are here for the duller reason: five lines of DOM per input, times
 * three dialogs, is where a `min` quietly stops matching its guard.
 */

export interface Sheet {
  /** Shows `form` modally. `onCancel` fires at most once if the sheet is dismissed. */
  show(form: HTMLFormElement, onCancel: () => void): void;
  /** Closes, marking the edit committed so `onCancel` will not fire. */
  commit(): void;
  close(): void;
  dispose(): void;
  readonly element: HTMLDialogElement;
}

export function createSheet(id: string, host: HTMLElement = document.body): Sheet {
  const dialog = document.createElement('dialog');
  dialog.id = id;
  dialog.className = 'sheet';
  host.append(dialog);

  let onCancel: (() => void) | null = null;
  let settled = true;

  const revert = (): void => {
    if (settled) return;
    settled = true;
    onCancel?.();
  };

  dialog.addEventListener('cancel', revert);

  const close = (): void => {
    if (dialog.open) dialog.close();
  };

  return {
    element: dialog,
    show(form, cancel) {
      onCancel = cancel;
      settled = false;
      dialog.replaceChildren(form);
      dialog.showModal();
    },
    commit() {
      settled = true;
      close();
    },
    close() {
      revert();
      close();
    },
    dispose() {
      settled = true;
      close();
      dialog.remove();
    },
  };
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.textContent = text;
  label.append(control);
  return label;
}

export interface NumberFieldOptions {
  readonly label: string;
  readonly id?: string;
  readonly dataset?: Readonly<Record<string, string>>;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly onChange: (value: number) => void;
}

/**
 * A number input that reports only values inside its own range.
 *
 * Out-of-range and half-typed input is IGNORED rather than clamped: clamping fights the
 * user mid-keystroke, turning a typed "50" into "5" and then "50" — and each of those
 * intermediate values would be applied to the chart.
 */
export function numberField(o: NumberFieldOptions): HTMLLabelElement {
  const input = document.createElement('input');
  input.type = 'number';
  if (o.id !== undefined) input.id = o.id;
  for (const [key, value] of Object.entries(o.dataset ?? {})) input.dataset[key] = value;
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);
  input.value = String(o.value);
  input.addEventListener('input', () => {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < o.min || value > o.max) return;
    o.onChange(o.step >= 1 ? Math.round(value) : value);
  });
  return labelled(o.label, input);
}

export interface SelectFieldOptions {
  readonly label: string;
  readonly id?: string;
  readonly dataset?: Readonly<Record<string, string>>;
  readonly options: readonly string[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export function selectField(o: SelectFieldOptions): HTMLLabelElement {
  const select = document.createElement('select');
  if (o.id !== undefined) select.id = o.id;
  for (const [key, value] of Object.entries(o.dataset ?? {})) select.dataset[key] = value;
  for (const option of o.options) {
    const node = document.createElement('option');
    node.value = option;
    node.textContent = option;
    select.append(node);
  }
  select.value = o.value;
  select.addEventListener('change', () => {
    o.onChange(select.value);
  });
  return labelled(o.label, select);
}

export interface ColorFieldOptions {
  readonly label: string;
  readonly id?: string;
  readonly dataset?: Readonly<Record<string, string>>;
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export function colorField(o: ColorFieldOptions): HTMLLabelElement {
  const input = document.createElement('input');
  input.type = 'color';
  if (o.id !== undefined) input.id = o.id;
  for (const [key, value] of Object.entries(o.dataset ?? {})) input.dataset[key] = value;
  input.value = o.value;
  input.addEventListener('input', () => {
    o.onChange(input.value);
  });
  return labelled(o.label, input);
}

export interface CheckboxFieldOptions {
  readonly label: string;
  readonly id?: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}

export function checkboxField(o: CheckboxFieldOptions): HTMLLabelElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  if (o.id !== undefined) input.id = o.id;
  input.checked = o.value;
  input.addEventListener('change', () => {
    o.onChange(input.checked);
  });
  return labelled(o.label, input);
}

export interface FooterButton {
  readonly label: string;
  readonly id: string;
  readonly primary?: boolean;
  readonly onSelect: () => void;
}

export function footer(buttons: readonly FooterButton[]): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row-end';
  for (const spec of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = spec.primary === true ? 'tb primary' : 'tb';
    button.id = spec.id;
    button.textContent = spec.label;
    button.addEventListener('click', spec.onSelect);
    row.append(button);
  }
  return row;
}

/** A form with an `<h2>` title, ready for field groups. */
export function sheetForm(title: string): HTMLFormElement {
  const form = document.createElement('form');
  form.method = 'dialog';
  const heading = document.createElement('h2');
  heading.textContent = title;
  form.append(heading);
  return form;
}
