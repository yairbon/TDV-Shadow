/**
 * Priority-plus overflow for the top bar.
 *
 * The bar is a single row that must not wrap, and it already held more than fits a
 * 1440px window: `scrollWidth` was 1668 against a 1440 client, so the layout picker,
 * sync, settings, theme and reset all sat past the right edge. They were reachable — the
 * bar scrolls — but nothing said so, and a control you cannot see is a control you do not
 * have. Bundling 20 more symbols made it worse by widening the symbol picker, and Tier 2
 * adds more controls still, so trimming labels would only postpone this.
 *
 * The controls are MOVED into the panel rather than mirrored by menu items. A mirror
 * means two widgets for one piece of state, and the copy drifts the first time someone
 * changes the original — this way there is exactly one `#theme-toggle` in the document
 * whether it is in the bar or in the panel, and every handler bound in `main.ts` keeps
 * working untouched because the node is the same node.
 *
 * Eviction order is declared on the elements themselves (`data-overflow` = lower goes
 * first), not inferred from DOM order, because "last in the bar" and "least important"
 * are not the same thing — the live toggle sits last and matters more than Reset.
 */

export interface ToolbarOverflow {
  /** Re-measures and moves controls in or out. Safe to call often. */
  refresh(): void;
  dispose(): void;
}

interface Managed {
  readonly element: HTMLElement;
  readonly priority: number;
  /** Where it belongs in the bar, so it goes back in the right place. */
  readonly nextSibling: ChildNode | null;
}

export function createToolbarOverflow(
  bar: HTMLElement,
  button: HTMLElement,
  panel: HTMLElement,
): ToolbarOverflow {
  const managed: Managed[] = [];
  for (const node of bar.querySelectorAll<HTMLElement>('[data-overflow]')) {
    const priority = Number(node.dataset['overflow'] ?? '0');
    managed.push({ element: node, priority, nextSibling: node.nextSibling });
  }
  // Least important first: that is the order they leave the bar in.
  managed.sort((a, b) => a.priority - b.priority);

  const inPanel = new Set<HTMLElement>();

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };

  /**
   * True when the bar's content exceeds its box.
   *
   * Compared with a 1px slack: `scrollWidth` and `clientWidth` are integers rounded from
   * fractional layout, so an exactly-fitting bar can report a 1px overflow forever and
   * evict a control that did fit.
   */
  const overflowing = (): boolean => bar.scrollWidth - bar.clientWidth > 1;

  const refresh = (): void => {
    // Start from everything back in the bar, then evict only what is needed. Measuring
    // incrementally from the current state cannot recover once the window widens again:
    // a control parked in the panel adds nothing to `scrollWidth`, so the bar always
    // looks like it fits and nothing ever comes back.
    for (const entry of managed) {
      if (!inPanel.has(entry.element)) continue;
      bar.insertBefore(entry.element, entry.nextSibling);
      inPanel.delete(entry.element);
    }
    button.hidden = true;

    if (!overflowing()) {
      setOpen(false);
      return;
    }

    // The button itself takes room, so it has to be present while measuring or the last
    // eviction is decided against a width the bar will not actually have.
    button.hidden = false;
    for (const entry of managed) {
      if (!overflowing()) break;
      panel.append(entry.element);
      inPanel.add(entry.element);
    }

    // Everything fitted once the button appeared; take it away again.
    if (inPanel.size === 0) {
      button.hidden = true;
      setOpen(false);
    }
  };

  const onButton = (): void => {
    setOpen(panel.hidden);
  };
  const onDocument = (event: MouseEvent): void => {
    if (panel.hidden) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (panel.contains(target) || button.contains(target)) return;
    setOpen(false);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false);
  };

  /**
   * Closes the panel once a control in it has been used.
   *
   * Without this the panel stays open over the top-right of the plot, where it swallows
   * the next click on the chart — a right-click on the price gutter landed on the panel
   * instead of opening the gutter's context menu.
   *
   * Buttons and selects close it; text inputs do not, because the ticker box lives in
   * here and closing the panel the moment it is focused would make it unusable.
   */
  const onPanelActivate = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('input, textarea') !== null) return;
    if (event.type === 'click' && target.closest('button') === null) return;
    setOpen(false);
  };

  button.addEventListener('click', onButton);
  panel.addEventListener('click', onPanelActivate);
  panel.addEventListener('change', onPanelActivate);
  document.addEventListener('pointerdown', onDocument);
  document.addEventListener('keydown', onKey);

  const observer = new ResizeObserver(() => {
    refresh();
  });
  observer.observe(bar);

  setOpen(false);
  refresh();

  return {
    refresh,
    dispose(): void {
      observer.disconnect();
      button.removeEventListener('click', onButton);
      panel.removeEventListener('click', onPanelActivate);
      panel.removeEventListener('change', onPanelActivate);
      document.removeEventListener('pointerdown', onDocument);
      document.removeEventListener('keydown', onKey);
    },
  };
}
