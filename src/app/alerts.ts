/**
 * Price alerts (Phase 9.2).
 *
 * An alert is a price level plus a memory of which side of it the market was last on.
 * That second half is what makes triggering meaningful: "the price is above 200" fires
 * forever, while "the price REACHED 200 having been below it" fires once, when it
 * happens, which is what a trader means by an alert.
 *
 * Crossing is tested against the bar's RANGE, not its close. A bar that spikes through a
 * level and closes back below it did reach the level — a close-only test would miss the
 * event entirely and, worse, would miss it silently.
 */

export interface Alert {
  readonly id: string;
  readonly symbol: string;
  readonly price: number;
  /** Which side the last observed price was on. Null until the first observation. */
  readonly side: 'above' | 'below' | null;
  readonly triggered: boolean;
  /** UTC epoch ms of the bar that triggered it, or null. */
  readonly triggeredAt: number | null;
}

export interface AlertStore {
  list(): readonly Alert[];
  /** Alerts for one symbol — the only ones that should be drawn or checked. */
  forSymbol(symbol: string): readonly Alert[];
  get(id: string): Alert | null;
  add(symbol: string, price: number): Alert;
  move(id: string, price: number): Alert | null;
  remove(id: string): boolean;
  clear(symbol?: string): number;
  /**
   * Observes one bar and returns the alerts that fired on it.
   *
   * Called per tick, so it must be cheap and must not fire twice for the same crossing.
   */
  observe(symbol: string, bar: { readonly h: number; readonly l: number; readonly c: number; readonly t: number }): readonly Alert[];
  /** Re-arms a triggered alert so it can fire again. */
  reset(id: string): Alert | null;
  subscribe(listener: () => void): () => void;
  toJSON(): string;
  loadJSON(json: string): number;
}

/**
 * Did `bar` reach `price`, coming from `side`?
 *
 * Exported for the tests, which is the point: this is the one piece of alert logic that
 * can be wrong in a way nobody notices until an alert fails to fire.
 */
export function crossed(
  price: number,
  side: Alert['side'],
  bar: { readonly h: number; readonly l: number },
): boolean {
  if (side === 'below') return bar.h >= price;
  if (side === 'above') return bar.l <= price;
  // No side recorded yet: the first bar only establishes which side we are on.
  return false;
}

export function sideOf(price: number, close: number): 'above' | 'below' {
  return close >= price ? 'above' : 'below';
}

export function createAlertStore(idSeed = 0): AlertStore {
  let alerts: Alert[] = [];
  let nextId = idSeed;
  const listeners = new Set<() => void>();

  const bump = (): void => {
    for (const listener of listeners) listener();
  };

  const replace = (id: string, next: Alert): Alert => {
    const index = alerts.findIndex((a) => a.id === id);
    alerts = [...alerts.slice(0, index), next, ...alerts.slice(index + 1)];
    return next;
  };

  return {
    list: () => alerts,
    forSymbol: (symbol) => alerts.filter((a) => a.symbol === symbol),
    get: (id) => alerts.find((a) => a.id === id) ?? null,

    add(symbol, price) {
      nextId += 1;
      const alert: Alert = Object.freeze({
        id: `a${String(nextId)}`,
        symbol,
        price,
        side: null,
        triggered: false,
        triggeredAt: null,
      });
      alerts = [...alerts, alert];
      bump();
      return alert;
    },

    move(id, price) {
      const current = alerts.find((a) => a.id === id);
      if (current === undefined) return null;
      // Moving an alert re-arms it: a level you just dragged somewhere new has not been
      // reached yet, and leaving it triggered would make it dead on arrival.
      const next = replace(
        id,
        Object.freeze({ ...current, price, side: null, triggered: false, triggeredAt: null }),
      );
      bump();
      return next;
    },

    remove(id) {
      const next = alerts.filter((a) => a.id !== id);
      if (next.length === alerts.length) return false;
      alerts = next;
      bump();
      return true;
    },

    clear(symbol) {
      const before = alerts.length;
      alerts = symbol === undefined ? [] : alerts.filter((a) => a.symbol !== symbol);
      if (alerts.length !== before) bump();
      return before - alerts.length;
    },

    observe(symbol, bar) {
      const fired: Alert[] = [];
      const previous = alerts;
      // Identity comparison rather than a mutated flag: TypeScript does not track
      // assignments made inside a callback, so a `let changed = false` here narrows to
      // `false` for the whole function and the notification is dropped.
      const next = previous.map((alert) => {
        if (alert.symbol !== symbol) return alert;
        const side = sideOf(alert.price, bar.c);
        const hit = !alert.triggered && crossed(alert.price, alert.side, bar);
        if (!hit && alert.side === side) return alert;
        const updated: Alert = Object.freeze({
          ...alert,
          side,
          triggered: alert.triggered || hit,
          triggeredAt: hit ? bar.t : alert.triggeredAt,
        });
        if (hit) fired.push(updated);
        return updated;
      });
      alerts = next;
      if (next.some((alert, i) => alert !== previous[i])) bump();
      return fired;
    },

    reset(id) {
      const current = alerts.find((a) => a.id === id);
      if (current === undefined) return null;
      const next = replace(
        id,
        Object.freeze({ ...current, side: null, triggered: false, triggeredAt: null }),
      );
      bump();
      return next;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    toJSON: () => JSON.stringify({ version: 1, alerts }),

    loadJSON(json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return 0;
      }
      if (typeof parsed !== 'object' || parsed === null) return 0;
      const list = (parsed as { alerts?: unknown }).alerts;
      if (!Array.isArray(list)) return 0;

      // Validated field by field: a price read straight from localStorage ends up in a
      // coordinate transform, and NaN there quietly poisons a whole frame.
      alerts = list.flatMap((entry): Alert[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const record = entry as Record<string, unknown>;
        const price = record['price'];
        const id = record['id'];
        const symbol = record['symbol'];
        if (typeof id !== 'string' || typeof symbol !== 'string') return [];
        if (typeof price !== 'number' || !Number.isFinite(price)) return [];
        const side = record['side'];
        const triggeredAt = record['triggeredAt'];
        return [
          Object.freeze({
            id,
            symbol,
            price,
            side: side === 'above' || side === 'below' ? side : null,
            triggered: record['triggered'] === true,
            triggeredAt: typeof triggeredAt === 'number' ? triggeredAt : null,
          }),
        ];
      });
      for (const alert of alerts) {
        const numeric = Number(alert.id.replace(/^a/, ''));
        if (Number.isFinite(numeric)) nextId = Math.max(nextId, numeric);
      }
      bump();
      return alerts.length;
    },
  };
}
