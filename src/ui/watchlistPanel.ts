/**
 * The watchlist panel.
 *
 * Rendering only. Every decision about what belongs in the list, what a row's price is, and
 * which row is active was made in `app/watchlist.ts`; this turns rows into DOM and turns
 * clicks back into intents. Keeping the split strict is what makes the list testable without
 * a browser and the panel replaceable without touching the rules.
 *
 * Root mandate #1 permits DOM for chrome outside the plot, which this is.
 */

import type { WatchRow } from '../app/watchlist.js';

export interface WatchlistHandlers {
  /** A row was chosen. The app loads that symbol. */
  readonly onPick: (symbol: string) => void;
  /** The × on a row. */
  readonly onRemove: (symbol: string) => void;
  /** The + button, with whatever the reader typed. */
  readonly onAdd: (symbol: string) => void;
  /** The panel was closed. */
  readonly onClose: () => void;
}

export interface WatchlistPanel {
  render(rows: readonly WatchRow[]): void;
  setOpen(open: boolean): void;
  isOpen(): boolean;
  destroy(): void;
}

/** `1,234.56` — grouped, and to the precision a price is actually quoted at. */
function formatPrice(price: number): string {
  const decimals = price >= 1000 ? 2 : price >= 1 ? 2 : 4;
  return price.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** `+1.23%`, with the sign always shown so a gain and a loss differ by more than colour. */
function formatChange(change: number): string {
  const percent = change * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createWatchlistPanel(
  host: HTMLElement,
  input: HTMLInputElement,
  list: HTMLElement,
  handlers: WatchlistHandlers,
): WatchlistPanel {
  const onListClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest('[data-symbol]');
    if (!(row instanceof HTMLElement)) return;
    const symbol = row.dataset['symbol'] ?? '';
    if (symbol === '') return;
    // The remove control sits inside the row, so the row's own handler would fire too and
    // load the symbol the reader just deleted.
    if (target.dataset['action'] === 'remove') {
      event.stopPropagation();
      handlers.onRemove(symbol);
      return;
    }
    handlers.onPick(symbol);
  };

  const submit = (): void => {
    const value = input.value;
    if (value.trim() === '') return;
    input.value = '';
    handlers.onAdd(value);
  };

  const onInputKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
      return;
    }
    // Escape closes the panel, but only from the box — from a row it would fight the
    // dialog-closing habit the rest of the app has.
    if (event.key === 'Escape') handlers.onClose();
  };

  list.addEventListener('click', onListClick);
  input.addEventListener('keydown', onInputKey);

  return {
    render(rows) {
      if (rows.length === 0) {
        list.innerHTML = '<li class="empty">No symbols. Add one above.</li>';
        return;
      }
      list.innerHTML = rows
        .map((row) => {
          const direction = row.change === null ? '' : row.change >= 0 ? 'up' : 'down';
          const price = row.price === null ? '—' : formatPrice(row.price);
          const change = row.change === null ? '' : formatChange(row.change);
          return (
            `<li data-symbol="${escapeHtml(row.symbol)}" class="${row.active ? 'active' : ''}"` +
            ` role="option" aria-selected="${String(row.active)}" tabindex="0">` +
            `<span class="wl-sym">${escapeHtml(row.symbol)}</span>` +
            `<span class="wl-px">${price}</span>` +
            `<span class="wl-ch ${direction}">${change}</span>` +
            `<button type="button" data-action="remove" data-symbol="${escapeHtml(row.symbol)}"` +
            ` aria-label="Remove ${escapeHtml(row.symbol)}" title="Remove">×</button>` +
            `</li>`
          );
        })
        .join('');
    },

    setOpen(open) {
      host.hidden = !open;
    },

    isOpen() {
      return !host.hidden;
    },

    destroy() {
      list.removeEventListener('click', onListClick);
      input.removeEventListener('keydown', onInputKey);
    },
  };
}
