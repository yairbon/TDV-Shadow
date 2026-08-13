/**
 * The drawing rail, grouped into flyouts.
 *
 * A flat rail does not scale. It held fifteen buttons against a catalogue of thirty
 * kinds, so half the tools this app implements had no way to reach them at all — and the
 * eight added in Tier 3 would have pushed a flat rail past the height of an 800px window,
 * where the overflow is a scrollbar nobody looks for.
 *
 * So the rail is groups, the way TradingView's is: one slot per family, showing whichever
 * member you used last, with a corner chevron that opens the rest. The slot's own button
 * activates what it shows — the common case stays one click, and picking a different
 * member costs two and then becomes the one-click case itself.
 *
 * The rail owns no tool state beyond "which member of each group was last used". Which
 * tool is ARMED lives in `main.ts`, and arrives here through `select` — the keyboard map
 * arms tools too, and two sources of truth for that would drift the moment someone
 * pressed a key while a flyout was open.
 */

export interface ToolGroup {
  /** Stable id, used for nothing but debugging and test selectors. */
  readonly id: string;
  /** Group name, shown as the flyout's heading. */
  readonly label: string;
  /** Rail tool ids, most-used first — the first is what the slot shows initially. */
  readonly tools: readonly string[];
}

export interface ToolRailOptions {
  readonly groups: readonly ToolGroup[];
  /** Inline SVG markup for a tool id. */
  icon: (tool: string) => string;
  /** Human label for a tool id. */
  label: (tool: string) => string;
  /** Called when the user picks a tool. `''` is the cursor. */
  onSelect: (tool: string) => void;
}

export interface ToolRail {
  /**
   * Reflects an armed tool into the rail: presses its slot, and makes it that group's
   * shown member. Accepts tools that are in no group (nothing is pressed) so callers do
   * not have to know the grouping.
   */
  select(tool: string): void;
  /** Adds a standalone button below the groups — magnet, erase, and the like. */
  addExtra(button: HTMLElement): void;
  addSeparator(): void;
  dispose(): void;
}

interface Slot {
  readonly group: ToolGroup;
  readonly button: HTMLButtonElement;
  readonly menu: HTMLDivElement | null;
  current: string;
}

export function createToolRail(host: HTMLElement, options: ToolRailOptions): ToolRail {
  const slots: Slot[] = [];
  let openMenu: HTMLDivElement | null = null;

  const closeMenu = (): void => {
    if (openMenu === null) return;
    openMenu.hidden = true;
    openMenu = null;
  };

  /**
   * Positions a flyout and clamps it inside the viewport.
   *
   * Done here rather than in CSS because the rail has two orientations — a vertical column
   * on the left at desktop widths, a horizontal bar along the bottom on phones — and a
   * static offset that suits one puts the menu off-screen in the other. A right-opening
   * menu on the phone bar ran past the right edge for every slot past the first few, and
   * centring it on the slot only moved which slots were wrong.
   *
   * `position: fixed`, so the coordinates are viewport coordinates and the rail's own
   * horizontal scroll does not have to be accounted for.
   */
  const placeMenu = (menu: HTMLDivElement, slot: HTMLElement): void => {
    const anchor = slot.getBoundingClientRect();
    const vertical = host.clientHeight > host.clientWidth;
    const gap = 6;
    const margin = 4;

    // Measure with the menu laid out but before it is placed.
    menu.style.left = '0px';
    menu.style.top = '0px';
    const box = menu.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    const clamp = (value: number, size: number, limit: number): number =>
      Math.max(margin, Math.min(value, limit - size - margin));

    // A vertical rail opens sideways; a horizontal one opens along its short axis, which
    // for a bottom bar means upwards.
    const x = vertical ? anchor.right + gap : anchor.left;
    const y = vertical ? anchor.top : anchor.top - box.height - gap;
    menu.style.left = `${String(clamp(x, box.width, vw))}px`;
    menu.style.top = `${String(clamp(y, box.height, vh))}px`;
  };

  const paint = (slot: Slot, armed: string): void => {
    slot.button.innerHTML = options.icon(slot.current);
    const label = options.label(slot.current);
    slot.button.title = slot.group.tools.length > 1 ? `${label} — hold for more` : label;
    slot.button.setAttribute('aria-label', label);
    slot.button.dataset['tool'] = slot.current;
    slot.button.setAttribute('aria-pressed', String(slot.current === armed));
  };

  let armedTool = '';

  const repaint = (): void => {
    for (const slot of slots) paint(slot, armedTool);
  };

  const choose = (slot: Slot, tool: string): void => {
    slot.current = tool;
    armedTool = tool;
    closeMenu();
    repaint();
    options.onSelect(tool);
  };

  for (const group of options.groups) {
    const wrap = document.createElement('div');
    wrap.className = 'rail-slot';
    wrap.dataset['group'] = group.id;

    const button = document.createElement('button');
    button.type = 'button';
    wrap.append(button);

    let menu: HTMLDivElement | null = null;
    if (group.tools.length > 1) {
      // The chevron is a span, not a button: a button inside a button is invalid HTML and
      // browsers unnest it, which drops the slot's own click handler.
      const chevron = document.createElement('span');
      chevron.className = 'rail-more';
      chevron.setAttribute('aria-hidden', 'true');
      wrap.append(chevron);

      menu = document.createElement('div');
      menu.className = 'rail-menu';
      menu.hidden = true;
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', group.label);
      for (const tool of group.tools) {
        const item = document.createElement('button');
        item.type = 'button';
        item.dataset['menuTool'] = tool;
        item.setAttribute('role', 'menuitem');
        item.innerHTML = `${options.icon(tool)}<span>${options.label(tool)}</span>`;
        menu.append(item);
      }
      wrap.append(menu);
    }

    const slot: Slot = { group, button, menu, current: group.tools[0] ?? '' };
    slots.push(slot);
    paint(slot, armedTool);

    button.addEventListener('click', () => {
      choose(slot, slot.current);
    });

    if (menu !== null) {
      const openable = menu;
      // The chevron sits on top of the button's bottom-right corner, so a click there
      // reaches the wrapper without reaching the button.
      wrap.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!target.classList.contains('rail-more')) return;
        event.stopPropagation();
        const wasOpen = openMenu === openable;
        closeMenu();
        if (wasOpen) return;
        openable.hidden = false;
        placeMenu(openable, wrap);
        openMenu = openable;
      });
      // Right-click and long-press open it too: on touch there is no hover, and the
      // chevron alone is a 10px target.
      wrap.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        closeMenu();
        openable.hidden = false;
        placeMenu(openable, wrap);
        openMenu = openable;
      });
      openable.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const item = target.closest<HTMLElement>('[data-menu-tool]');
        if (item === null) return;
        event.stopPropagation();
        choose(slot, item.dataset['menuTool'] ?? '');
      });
    }

    host.append(wrap);
  }

  const onDocument = (event: MouseEvent): void => {
    if (openMenu === null) return;
    const target = event.target;
    if (target instanceof Node && openMenu.parentElement?.contains(target) === true) return;
    closeMenu();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeMenu();
  };
  document.addEventListener('pointerdown', onDocument);
  document.addEventListener('keydown', onKey);

  return {
    select(tool) {
      armedTool = tool;
      for (const slot of slots) {
        if (slot.group.tools.includes(tool)) slot.current = tool;
      }
      closeMenu();
      repaint();
    },
    addExtra(button) {
      host.append(button);
    },
    addSeparator() {
      const separator = document.createElement('div');
      separator.className = 'sep';
      host.append(separator);
    },
    dispose() {
      document.removeEventListener('pointerdown', onDocument);
      document.removeEventListener('keydown', onKey);
    },
  };
}
