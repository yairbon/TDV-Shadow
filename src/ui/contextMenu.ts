/**
 * Right-click menu (Phase 7.3).
 *
 * DOM, not canvas — mandate #1 forbids DOM for candles, wicks, axes, gridlines and the
 * crosshair; a menu is chrome, like the toolbar and the search dialog. Drawing it on the
 * crosshair layer would also mean re-implementing focus, hover and keyboard navigation
 * against a canvas, which is exactly the work the platform already did.
 *
 * The menu is a pure renderer of the entries it is handed. It holds no chart state and
 * knows nothing about drawings or scales: callers decide what the menu says, this file
 * decides where it goes and how it is driven. That keeps the region logic (what a
 * right-click on the price gutter means) in one place — the chrome — rather than smeared
 * across a widget.
 */

export interface MenuItem {
  readonly label: string;
  readonly onSelect?: () => void;
  /** One level of nesting. Deeper menus are a navigation problem, not a feature. */
  readonly items?: readonly MenuEntry[];
  /** Shows a tick. Use for toggles, so the current state is visible before clicking. */
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** Destructive styling — remove, clear. */
  readonly danger?: boolean;
}

export type MenuEntry = MenuItem | 'separator';

export interface ContextMenu {
  /** Opens at a VIEWPORT point, clamped so the menu is always fully on screen. */
  open(x: number, y: number, entries: readonly MenuEntry[]): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

const GAP = 4;

function isItem(entry: MenuEntry): entry is MenuItem {
  return entry !== 'separator';
}

export function createContextMenu(host: HTMLElement = document.body): ContextMenu {
  const root = document.createElement('div');
  root.id = 'context-menu';
  root.className = 'ctx';
  root.setAttribute('role', 'menu');
  root.hidden = true;

  /** The open submenu, if any. Only one level, so one slot is enough. */
  let submenu: HTMLElement | null = null;
  let open = false;

  /**
   * Places a panel so it stays inside the viewport. `preferRight` is how a submenu wants
   * to sit relative to its parent row; the flip is what keeps it visible near the edge.
   */
  const place = (panel: HTMLElement, x: number, y: number, flipTo?: number): void => {
    panel.style.left = '0px';
    panel.style.top = '0px';
    const { width, height } = panel.getBoundingClientRect();
    const maxX = window.innerWidth - GAP;
    const maxY = window.innerHeight - GAP;
    let left = x;
    if (left + width > maxX) left = flipTo === undefined ? maxX - width : flipTo - width;
    let top = y;
    if (top + height > maxY) top = Math.max(GAP, maxY - height);
    panel.style.left = `${String(Math.max(GAP, left))}px`;
    panel.style.top = `${String(Math.max(GAP, top))}px`;
  };

  const closeSubmenu = (): void => {
    submenu?.remove();
    submenu = null;
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    closeSubmenu();
    root.hidden = true;
    root.replaceChildren();
  };

  const activate = (item: MenuItem): void => {
    if (item.disabled === true || item.items !== undefined) return;
    close();
    item.onSelect?.();
  };

  /**
   * Builds one panel of rows. Returns the element; the caller positions it.
   *
   * `root` panels own the submenu; nested ones must not, or moving the pointer INTO the
   * submenu fires pointerenter on a nested row, which closes the panel the pointer is
   * standing on and the click lands on nothing.
   */
  const build = (entries: readonly MenuEntry[], panel: HTMLElement, isRoot: boolean): HTMLElement => {
    panel.replaceChildren();
    for (const entry of entries) {
      if (!isItem(entry)) {
        const rule = document.createElement('div');
        rule.className = 'sep';
        panel.append(rule);
        continue;
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row';
      row.setAttribute('role', 'menuitem');
      row.dataset['label'] = entry.label;
      row.disabled = entry.disabled === true;
      if (entry.danger === true) row.classList.add('danger');
      if (entry.checked === true) row.classList.add('checked');

      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = entry.checked === true ? '✓' : '';
      const text = document.createElement('span');
      text.className = 'label';
      text.textContent = entry.label;
      row.append(tick, text);

      if (entry.items !== undefined) {
        row.setAttribute('aria-haspopup', 'true');
        const caret = document.createElement('span');
        caret.className = 'caret';
        caret.textContent = '›';
        row.append(caret);
      }

      const openSubmenu = (): void => {
        closeSubmenu();
        const nested = entry.items;
        if (nested === undefined) return;
        const child = document.createElement('div');
        child.className = 'ctx';
        child.setAttribute('role', 'menu');
        host.append(child);
        build(nested, child, false);
        const box = row.getBoundingClientRect();
        place(child, box.right - 2, box.top, box.left + 2);
        submenu = child;
      };

      if (isRoot) {
        row.addEventListener('pointerenter', () => {
          if (entry.items === undefined) closeSubmenu();
          else openSubmenu();
        });
      }
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        if (entry.items !== undefined) {
          openSubmenu();
          return;
        }
        activate(entry);
      });
      panel.append(row);
    }
    return panel;
  };

  /** Every focusable row across the root and its open submenu, in visual order. */
  const rows = (): HTMLButtonElement[] => {
    const panel = submenu ?? root;
    return [...panel.querySelectorAll('button.row')].filter(
      (node): node is HTMLButtonElement => node instanceof HTMLButtonElement && !node.disabled,
    );
  };

  const move = (delta: number): void => {
    const list = rows();
    if (list.length === 0) return;
    const current = list.findIndex((row) => row === document.activeElement);
    const next = current < 0 ? (delta > 0 ? 0 : list.length - 1) : (current + delta + list.length) % list.length;
    list[next].focus();
  };

  // Capture phase: a right-click inside the menu region must not reach the chart, and
  // Escape must close the menu rather than cancelling the chart's active tool.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      const focused = document.activeElement;
      if (event.key === 'ArrowRight' && focused instanceof HTMLElement) {
        focused.dispatchEvent(new PointerEvent('pointerenter'));
        rows()[0]?.focus();
      } else {
        closeSubmenu();
        rows()[0]?.focus();
      }
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!open) return;
    const target = event.target;
    if (target instanceof Node && (root.contains(target) || submenu?.contains(target) === true)) {
      return;
    }
    close();
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  host.append(root);

  return {
    open(x, y, entries) {
      closeSubmenu();
      root.hidden = false;
      open = true;
      build(entries, root, true);
      place(root, x, y);
    },
    close,
    isOpen: () => open,
    dispose() {
      close();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      root.remove();
    },
  };
}
