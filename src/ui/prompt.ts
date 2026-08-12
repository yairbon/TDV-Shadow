/**
 * A small text prompt, built on `<dialog>`.
 *
 * Not `window.prompt`. The published build runs inside a sandboxed iframe, where modals
 * are only available if the host granted `allow-modals` — so `window.prompt` can return
 * null without ever showing anything, and "Save layout" would silently do nothing in the
 * one place most people will actually use the app. It is also synchronous and blocks the
 * render loop, which mandate #3 exists to keep clear of.
 *
 * Resolves to the trimmed text, or null when cancelled.
 */

export interface TextPrompt {
  ask(request: {
    readonly title: string;
    readonly label: string;
    readonly value?: string;
    readonly confirmLabel?: string;
  }): Promise<string | null>;
  dispose(): void;
}

export function createTextPrompt(): TextPrompt {
  const dialog = document.createElement('dialog');
  dialog.id = 'text-prompt';
  dialog.innerHTML =
    '<form method="dialog">' +
    '<h2 class="tp-title"></h2>' +
    '<label class="tp-label" for="tp-input"></label>' +
    '<input id="tp-input" type="text" autocomplete="off" spellcheck="false" />' +
    '<div class="tp-actions">' +
    '<button type="button" class="tp-cancel">Cancel</button>' +
    '<button type="submit" class="tp-confirm">Save</button>' +
    '</div>' +
    '</form>';
  document.body.append(dialog);

  const title = dialog.querySelector<HTMLElement>('.tp-title');
  const label = dialog.querySelector<HTMLElement>('.tp-label');
  const input = dialog.querySelector<HTMLInputElement>('#tp-input');
  const confirm = dialog.querySelector<HTMLButtonElement>('.tp-confirm');
  const cancel = dialog.querySelector<HTMLButtonElement>('.tp-cancel');

  let settle: ((value: string | null) => void) | null = null;

  /** Resolves exactly once. `close` fires for Escape as well as for either button. */
  const finish = (value: string | null): void => {
    const resolve = settle;
    settle = null;
    if (dialog.open) dialog.close();
    resolve?.(value);
  };

  cancel?.addEventListener('click', () => {
    finish(null);
  });
  dialog.addEventListener('close', () => {
    // Escape and the backdrop both land here without a click, so a pending promise would
    // otherwise never settle and the caller would hang forever.
    finish(null);
  });
  dialog.addEventListener('submit', (event) => {
    event.preventDefault();
    finish(input?.value.trim() ?? '');
  });

  return {
    ask(request) {
      if (title !== null) title.textContent = request.title;
      if (label !== null) label.textContent = request.label;
      if (input !== null) input.value = request.value ?? '';
      if (confirm !== null) confirm.textContent = request.confirmLabel ?? 'Save';
      dialog.showModal();
      input?.focus();
      input?.select();
      return new Promise<string | null>((resolve) => {
        settle = resolve;
      });
    },
    dispose() {
      finish(null);
      dialog.remove();
    },
  };
}
