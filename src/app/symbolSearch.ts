/**
 * Ranking engine for the ⌘K symbol search.
 *
 * Pure: no module-level mutable state, no DOM, no `Date`, no data dependency. The symbol
 * list is a parameter so the dialog can pass `SYMBOLS` while tests pass fixtures.
 *
 * The replaced matcher was `symbol.includes(q) || label.includes(q)` in declaration order,
 * which has no notion of a best match: `APL` found nothing and `A` returned a dozen tickers
 * in whatever order the array happened to be in.
 *
 * ## Ranking tiers (descending)
 *
 * | tier | meaning                                    | example              |
 * |------|--------------------------------------------|----------------------|
 * | 5    | exact ticker                               | `aapl` → AAPL        |
 * | 4    | ticker prefix                              | `AA` → AAPL          |
 * | 3    | word start inside the label                | `gold` → GLD · **Gold** ETF |
 * | 2    | substring anywhere in ticker or label      | `esla` → TSLA        |
 * | 1    | subsequence (fuzzy) in the **ticker only** | `GGL` → **G**OO**GL** |
 *
 * Fuzzy is deliberately not run over labels: with two-to-four-word labels, subsequence
 * matching makes almost everything match almost everything and the ranking stops meaning
 * anything.
 *
 * ## Ordering within a tier
 *
 * 1. **Coverage** — prefix tier only: a 2-char query covers more of `KO` than of `GOOGL`,
 *    so shorter tickers win. Every other tier scores a constant here, so this never
 *    reorders anything outside tier 4.
 * 2. **Recency** — `options.recents` is most-recent-first and the POSITION counts: the
 *    first recent outranks the second.
 * 3. **Contiguity** — `queryLength / matchSpan`. 1.0 for any contiguous match, so it only
 *    separates fuzzy hits (`GGL` in GOOGL spans 5 chars for 3 → 0.6).
 * 4. **Ticker, alphabetically** — the final tiebreak, which is what makes the order
 *    independent of the input array's order.
 *
 * All four are packed into the single `score` integer in disjoint decimal bands, so
 * sorting by `score` descending (then ticker ascending) *is* the ordering above. `score`
 * is comparable only within one result set — it is not a similarity percentage.
 */

/** Half-open `[start, end)` index range into the string it annotates. */
export type MatchRange = readonly [number, number];

export interface SearchableSymbol {
  readonly symbol: string;
  readonly label: string;
}

export interface SearchHit<T extends SearchableSymbol> {
  readonly item: T;
  /** Higher is better. Only meaningful for ordering within one result set. */
  readonly score: number;
  /** Index ranges in `symbol` that matched, for highlighting in the dialog. */
  readonly symbolRanges: readonly MatchRange[];
  /** Index ranges in `label` that matched. */
  readonly labelRanges: readonly MatchRange[];
}

export interface SearchOptions {
  /** Most-recent-first list of tickers. Position matters, not just membership. */
  readonly recents?: readonly string[];
  /** Max hits returned. Applied AFTER ranking, so a small limit still yields the best. */
  readonly limit?: number;
}

/** Default `options.limit`. The dialog scrolls; this only bounds the DOM it builds. */
export const DEFAULT_SEARCH_LIMIT = 50;

const TIER_PREFIX = 4;
const TIER_WORD_START = 3;
const TIER_SUBSTRING = 2;
const TIER_FUZZY = 1;
/** Empty query: everything is a hit, and only recency and the alphabet order it. */
const TIER_NONE = 0;

// Disjoint decimal bands. Each factor is an integer in [0, 1000], and each weight is
// >1000x the one below it, so a higher-priority factor can never be outvoted by the sum
// of the lower ones. Max score 5e12 + 1e11 + 1e7 + 1e3, well inside Number.MAX_SAFE_INTEGER.
const TIER_WEIGHT = 1_000_000_000_000;
const COVERAGE_WEIGHT = 100_000_000;
const RECENT_WEIGHT = 10_000;
const CONTIGUITY_WEIGHT = 1;
const SCALE = 1000;

/**
 * Case-folds while preserving indices one-for-one, so ranges computed on the folded text
 * are valid in the original. Plain `toUpperCase()` can lengthen a string (`ß` → `SS`),
 * which would silently shift every range after it; such characters are left unfolded.
 */
function fold(text: string): string {
  const upper = text.toUpperCase();
  if (upper.length === text.length) return upper;
  let out = '';
  for (const char of text) {
    const upperChar = char.toUpperCase();
    out += upperChar.length === char.length ? upperChar : char;
  }
  return out;
}

/** Trims and collapses internal runs of whitespace, then folds. `" a apl "` → `"A APL"`. */
function normalizeQuery(query: string): string {
  return fold(query.trim().replace(/\s+/g, ' '));
}

function isWordChar(code: number): boolean {
  // 0-9, A-Z. Folded text only, so lowercase never appears.
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
}

/** All non-overlapping occurrences of `needle`, ascending. Empty needle → no ranges. */
function occurrences(haystack: string, needle: string): MatchRange[] {
  if (needle === '') return [];
  const ranges: MatchRange[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return ranges;
    ranges.push([at, at + needle.length]);
    from = at + needle.length;
  }
}

/** Index of the first occurrence of `needle` that begins a word, or -1. */
function wordStartIndex(haystack: string, needle: string): number {
  if (needle === '') return -1;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return -1;
    if (at === 0 || !isWordChar(haystack.charCodeAt(at - 1))) return at;
    from = at + 1;
  }
}

/**
 * Greedy left-to-right subsequence match, returned as merged contiguous runs.
 * `GGL` against `GOOGL` → `[[0,1],[3,5]]`. Null when the needle is not a subsequence.
 */
function subsequenceRanges(haystack: string, needle: string): MatchRange[] | null {
  if (needle === '') return null;
  const ranges: MatchRange[] = [];
  let start = -1;
  let end = -1;
  let at = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found === -1) return null;
    if (found === end) {
      end = found + 1;
    } else {
      if (start !== -1) ranges.push([start, end]);
      start = found;
      end = found + 1;
    }
    at = found + 1;
  }
  if (start !== -1) ranges.push([start, end]);
  return ranges;
}

/**
 * `queryLength / span` in [0, 1000] for a fuzzy match. Every literal match is contiguous
 * by construction and scores a flat 1000, so this only ever separates fuzzy hits.
 */
function contiguityOf(ranges: readonly MatchRange[], queryLength: number): number {
  if (ranges.length === 0 || queryLength === 0) return SCALE;
  const first = ranges[0][0];
  const last = ranges[ranges.length - 1][1];
  const span = last - first;
  if (span <= queryLength) return SCALE;
  return Math.round((SCALE * queryLength) / span);
}

/** Higher for a more recent symbol, 0 for one that is not in `recents` at all. */
function recentRank(recents: ReadonlyMap<string, number>, foldedSymbol: string): number {
  const index = recents.get(foldedSymbol);
  if (index === undefined) return 0;
  return Math.max(1, SCALE - index);
}

function tierOf(
  foldedSymbol: string,
  foldedLabel: string,
  query: string,
  fuzzy: MatchRange[] | null,
): number {
  // An exact ticker needs no tier of its own. It is a prefix whose coverage is exactly
  // 1000, and every other prefix match has query.length < symbol.length and therefore
  // coverage below 1000 — so exact already sorts above them all. A separate TIER_EXACT
  // was here and could not change any output; no test could tell it from its absence,
  // which makes it the kind of code that only looks covered.
  if (foldedSymbol.startsWith(query)) return TIER_PREFIX;
  if (wordStartIndex(foldedLabel, query) !== -1) return TIER_WORD_START;
  if (foldedSymbol.includes(query) || foldedLabel.includes(query)) return TIER_SUBSTRING;
  if (fuzzy !== null) return TIER_FUZZY;
  return TIER_NONE;
}

interface Ranked<T extends SearchableSymbol> {
  readonly hit: SearchHit<T>;
  readonly sortKey: string;
}

function rank<T extends SearchableSymbol>(
  item: T,
  query: string,
  recents: ReadonlyMap<string, number>,
): Ranked<T> | null {
  const foldedSymbol = fold(item.symbol);
  const foldedLabel = fold(item.label);
  const recency = recentRank(recents, foldedSymbol);

  if (query === '') {
    return {
      hit: { item, score: recency * RECENT_WEIGHT, symbolRanges: [], labelRanges: [] },
      sortKey: foldedSymbol,
    };
  }

  const symbolLiteral = occurrences(foldedSymbol, query);
  const labelRanges = occurrences(foldedLabel, query);
  const fuzzy = symbolLiteral.length > 0 ? null : subsequenceRanges(foldedSymbol, query);
  const tier = tierOf(foldedSymbol, foldedLabel, query, fuzzy);
  if (tier === TIER_NONE) return null;

  // Scattered ticker characters are only highlighted when the fuzzy match is what got the
  // item into the results; otherwise the highlight would not correspond to why it matched.
  const fuzzyRanges = tier === TIER_FUZZY ? (fuzzy ?? []) : [];
  const symbolRanges = symbolLiteral.length > 0 ? symbolLiteral : fuzzyRanges;
  // Coverage only separates prefix hits; elsewhere it is a constant and cannot reorder.
  const coverage =
    tier === TIER_PREFIX ? Math.round((SCALE * query.length) / foldedSymbol.length) : SCALE;
  const contiguity = tier === TIER_FUZZY ? contiguityOf(fuzzyRanges, query.length) : SCALE;

  const score =
    tier * TIER_WEIGHT +
    coverage * COVERAGE_WEIGHT +
    recency * RECENT_WEIGHT +
    contiguity * CONTIGUITY_WEIGHT;

  return { hit: { item, score, symbolRanges, labelRanges }, sortKey: foldedSymbol };
}

/**
 * Ranks `symbols` against `query`, best first.
 *
 * An empty (or all-whitespace) query returns everything: recents first in recents order,
 * then the rest alphabetically. No match returns an empty array — the "search the network"
 * row is the dialog's business, not this module's.
 */
export function searchSymbols<T extends SearchableSymbol>(
  query: string,
  symbols: readonly T[],
  options?: SearchOptions,
): readonly SearchHit<T>[] {
  const limit = Math.floor(options?.limit ?? DEFAULT_SEARCH_LIMIT);
  if (limit <= 0) return [];

  const normalized = normalizeQuery(query);

  const recents = new Map<string, number>();
  for (const [index, recent] of (options?.recents ?? []).entries()) {
    const key = fold(recent.trim());
    if (!recents.has(key)) recents.set(key, index);
  }

  const ranked: Ranked<T>[] = [];
  for (const item of symbols) {
    const hit = rank(item, normalized, recents);
    if (hit !== null) ranked.push(hit);
  }

  // Total order: nothing falls through to the input array's order.
  ranked.sort((a, b) => {
    if (b.hit.score !== a.hit.score) return b.hit.score - a.hit.score;
    if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
    return a.hit.item.label < b.hit.item.label ? -1 : a.hit.item.label > b.hit.item.label ? 1 : 0;
  });

  const hits: SearchHit<T>[] = [];
  for (const entry of ranked) {
    if (hits.length === limit) break;
    hits.push(entry.hit);
  }
  return hits;
}
