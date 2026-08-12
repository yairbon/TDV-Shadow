/**
 * Object tree — everything on the chart, in one list.
 *
 * `Drawing` has carried `visible` and `locked` since the store was written, and both are
 * honoured by the renderer and the pointer layer. Until now the only way to reach either
 * was the per-drawing context menu: you had to find the shape on the plot before you
 * could hide it, which is precisely the situation where you cannot find it. Hiding and
 * locking everything at once had no surface at all.
 *
 * The list is rebuilt from a snapshot on every change rather than diffed. A drawing set
 * is tens of items, so a diff buys nothing measurable and costs the bug where a row's
 * dataset drifts out of step with the store it claims to describe.
 */

export interface ObjectRow {
  readonly id: string;
  /** Tool name, e.g. "Trend Line". */
  readonly label: string;
  /** Distinguishing detail — the price, the bar span. May be empty. */
  readonly detail: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly selected: boolean;
}

export interface ObjectTreeHandlers {
  onSelect(id: string): void;
  onToggleVisible(id: string): void;
  onToggleLocked(id: string): void;
  onRemove(id: string): void;
  /** Applies to every row at once. */
  onAllVisible(visible: boolean): void;
  onAllLocked(locked: boolean): void;
}

export interface ObjectTree {
  /** Shows the panel and renders `rows`. */
  open(rows: readonly ObjectRow[]): void;
  /** Re-renders if open; a no-op when closed, so callers can push updates freely. */
  update(rows: readonly ObjectRow[]): void;
  close(): void;
  isOpen(): boolean;
}

const EYE_OPEN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/></svg>';
const EYE_SHUT =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6c2 0 3.8.6 5.2 1.4M22 12s-3.5 6-10 6c-2 0-3.8-.6-5.2-1.4"/><path d="M3 3l18 18"/></svg>';
const LOCK_SHUT =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const LOCK_OPEN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7-2.6"/></svg>';
const BIN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';

/** Escapes text destined for `innerHTML`. Drawing labels are ours, details are derived. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createObjectTree(handlers: ObjectTreeHandlers): ObjectTree {
  const panel = document.createElement('div');
  panel.id = 'object-tree';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Objects on the chart');

  const head = document.createElement('div');
  head.className = 'ot-head';
  head.innerHTML =
    '<span class="ot-title">Objects</span>' +
    '<button type="button" class="ot-bulk" data-bulk="show">Show all</button>' +
    '<button type="button" class="ot-bulk" data-bulk="hide">Hide all</button>' +
    '<button type="button" class="ot-bulk" data-bulk="unlock">Unlock all</button>' +
    '<button type="button" class="ot-bulk" data-bulk="lock">Lock all</button>' +
    '<button type="button" class="ot-close" aria-label="Close">✕</button>';

  const list = document.createElement('ul');
  list.className = 'ot-list';

  panel.append(head, list);
  document.body.append(panel);

  const render = (rows: readonly ObjectRow[]): void => {
    if (rows.length === 0) {
      list.innerHTML = '<li class="ot-empty">Nothing drawn yet</li>';
      return;
    }
    list.innerHTML = rows
      .map(
        (row) =>
          `<li class="ot-row${row.selected ? ' selected' : ''}" data-id="${escapeHtml(row.id)}">` +
          `<button type="button" class="ot-name" data-act="select">` +
          `<span class="ot-label">${escapeHtml(row.label)}</span>` +
          `<span class="ot-detail">${escapeHtml(row.detail)}</span></button>` +
          `<button type="button" class="ot-icon" data-act="visible" ` +
          `aria-pressed="${String(row.visible)}" ` +
          `aria-label="${row.visible ? 'Hide' : 'Show'}">${row.visible ? EYE_OPEN : EYE_SHUT}</button>` +
          `<button type="button" class="ot-icon" data-act="locked" ` +
          `aria-pressed="${String(row.locked)}" ` +
          `aria-label="${row.locked ? 'Unlock' : 'Lock'}">${row.locked ? LOCK_SHUT : LOCK_OPEN}</button>` +
          `<button type="button" class="ot-icon" data-act="remove" aria-label="Remove">${BIN}</button>` +
          `</li>`,
      )
      .join('');
  };

  head.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.ot-close') !== null) {
      panel.hidden = true;
      return;
    }
    const bulk = target.closest<HTMLElement>('[data-bulk]')?.dataset['bulk'];
    if (bulk === 'show') handlers.onAllVisible(true);
    else if (bulk === 'hide') handlers.onAllVisible(false);
    else if (bulk === 'lock') handlers.onAllLocked(true);
    else if (bulk === 'unlock') handlers.onAllLocked(false);
  });

  list.addEventListener('click', (event) => {
    const target = event.target;
    // `Element`, not `HTMLElement`: these buttons contain SVG icons, so a click's target
    // is usually an `SVGElement`, which does NOT extend `HTMLElement`. Guarding on the
    // narrower type dropped every icon click while the text-only header buttons kept
    // working, which reads as the list handler being wired wrong rather than the guard
    // being too narrow.
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>('.ot-row');
    const id = row?.dataset['id'];
    if (id === undefined) return;
    switch (target.closest<HTMLElement>('[data-act]')?.dataset['act']) {
      case 'select':
        handlers.onSelect(id);
        break;
      case 'visible':
        handlers.onToggleVisible(id);
        break;
      case 'locked':
        handlers.onToggleLocked(id);
        break;
      case 'remove':
        handlers.onRemove(id);
        break;
      default:
        break;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) panel.hidden = true;
  });

  return {
    open(rows) {
      panel.hidden = false;
      render(rows);
    },
    update(rows) {
      // Guarded rather than unconditional so a caller can wire this to every store change
      // without repainting a hidden panel on every drag frame.
      if (panel.hidden) return;
      render(rows);
    },
    close() {
      panel.hidden = true;
    },
    isOpen: () => !panel.hidden,
  };
}
