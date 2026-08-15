/**
 * The watchlist's state, with no DOM and no I/O.
 *
 * A watchlist is a small thing that goes wrong in boring ways: the same symbol twice, an
 * entry the user cannot remove, an order that shuffles on reload, a price from one
 * instrument shown against another's name. Every one of those is a property of the list
 * rather than of its rendering, so the list lives here where it can be tested directly and
 * the panel is left with nothing to decide.
 *
 * Quotes are held ALONGSIDE the symbols rather than inside them: a symbol is a permanent
 * membership fact, a quote is a perishable observation, and merging the two makes it easy
 * to write code that keeps showing a price for a row after the row has gone.
 */

import type { Quote } from '../providers/types.js';

/** What the panel needs to draw one row. */
export interface WatchRow {
  readonly symbol: string;
  /** Null until a quote has arrived, and after one has been explicitly dropped. */
  readonly price: number | null;
  /** Change against the session's previous close, as a fraction. Null when unknown. */
  readonly change: number | null;
  /** True while this row is the chart's symbol. */
  readonly active: boolean;
}

export interface WatchlistState {
  readonly symbols: readonly string[];
  readonly quotes: ReadonlyMap<string, { readonly price: number; readonly change: number | null }>;
}

/** The default list — recognisable names, so an empty workspace is not an empty panel. */
export const DEFAULT_WATCHLIST: readonly string[] = Object.freeze([
  'AAPL',
  'MSFT',
  'NVDA',
  'TSLA',
  'SPY',
]);

/** Upper-cased and trimmed. The panel, the chart and the provider must agree on the key. */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function createWatchlist(symbols: readonly string[] = DEFAULT_WATCHLIST): WatchlistState {
  return { symbols: dedupe(symbols), quotes: new Map() };
}

/** Removes blanks and repeats, preserving first-seen order. */
function dedupe(symbols: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of symbols) {
    const symbol = normalizeSymbol(raw);
    if (symbol === '' || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

/**
 * Adds a symbol at the END, or returns the state unchanged if it is already listed.
 *
 * Appending rather than prepending: the list is something the reader arranges, and a symbol
 * jumping to the top because it was re-added would reorder a list they had put in order.
 */
export function addSymbol(state: WatchlistState, symbol: string): WatchlistState {
  const key = normalizeSymbol(symbol);
  if (key === '' || state.symbols.includes(key)) return state;
  return { ...state, symbols: [...state.symbols, key] };
}

/**
 * Removes a symbol, and the quote held for it.
 *
 * Dropping the quote matters: without it a re-added symbol would render with a price from
 * before it left the list, which is indistinguishable from a fresh one.
 */
export function removeSymbol(state: WatchlistState, symbol: string): WatchlistState {
  const key = normalizeSymbol(symbol);
  if (!state.symbols.includes(key)) return state;
  const quotes = new Map(state.quotes);
  quotes.delete(key);
  return { symbols: state.symbols.filter((entry) => entry !== key), quotes };
}

/**
 * Records a quote, ignoring one for a symbol that is not listed.
 *
 * The guard is the point: quote requests are in flight while the list is being edited, and
 * a late answer for a removed symbol would otherwise re-create an entry the reader deleted.
 *
 * The baseline for the change comes from the quote itself — every provider sends the
 * previous close and the app used to discard it, which left the percentage derivable only
 * for whichever instrument happened to be on the chart. `override` exists for the caller
 * that genuinely knows better; when neither is available the last known change is kept
 * rather than blanked, because the quote endpoint is polled far more often than anything
 * that could re-establish the baseline.
 */
export function applyQuote(
  state: WatchlistState,
  quote: Quote,
  override: number | null = null,
): WatchlistState {
  const key = normalizeSymbol(quote.symbol);
  if (!state.symbols.includes(key)) return state;
  if (!Number.isFinite(quote.price) || quote.price <= 0) return state;
  const baseline = override ?? quote.previousClose;
  const change =
    baseline !== null && Number.isFinite(baseline) && baseline > 0
      ? quote.price / baseline - 1
      : (state.quotes.get(key)?.change ?? null);
  const quotes = new Map(state.quotes);
  quotes.set(key, { price: quote.price, change });
  return { ...state, quotes };
}

/** The rows to draw, in list order, marking which one the chart is showing. */
export function rowsOf(state: WatchlistState, activeSymbol: string): readonly WatchRow[] {
  const active = normalizeSymbol(activeSymbol);
  return state.symbols.map((symbol) => {
    const quote = state.quotes.get(symbol);
    return {
      symbol,
      price: quote?.price ?? null,
      change: quote?.change ?? null,
      active: symbol === active,
    };
  });
}

/** What gets persisted. Only the membership: a stored price is a lie the moment it is read. */
export function toStorage(state: WatchlistState): readonly string[] {
  return [...state.symbols];
}

/** Rebuilds from storage, tolerating anything that is not a list of strings. */
export function fromStorage(raw: unknown): WatchlistState {
  if (!Array.isArray(raw)) return createWatchlist();
  const symbols = raw.filter((entry): entry is string => typeof entry === 'string');
  // An empty stored list is a real choice — the reader removed everything — and must not
  // be silently repopulated with the defaults.
  return { symbols: dedupe(symbols), quotes: new Map() };
}
