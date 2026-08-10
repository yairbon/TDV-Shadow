/**
 * Paged historical fetch.
 *
 * `GET /history?sym&tf&to=<ms>&limit=<=5000` returns a **descending** page and
 * the cursor is the oldest returned `ts` (ARCHITECTURE.md §3.3). Pages are
 * merged ascending here so the store only ever sees ascending, de-duplicated
 * bars — `bars[i].t < bars[i+1].t` is a §3.1 invariant.
 *
 * The transport is injected: no `fetch`, no DOM, and paging logic stays
 * testable against a scripted server.
 */

import type { Bar, Timeframe, TimeMs } from '../types.js';
import { asTimeMs } from '../types.js';
import type { Codec } from '../codec.js';
import { createCodec } from '../codec.js';

/** Hard server-side cap from §3.3. */
export const HISTORY_MAX_LIMIT = 5000;
export const HISTORY_DEFAULT_LIMIT = 1000;
/** Stops a broken server (cursor never advancing) from looping forever. */
export const HISTORY_MAX_PAGES = 64;

export interface HistoryQuery {
  readonly sym: string;
  readonly tf: Timeframe;
  /** Exclusive-or-inclusive upper bound; `null` means "latest". Overlap is de-duped. */
  readonly to: TimeMs | null;
  readonly limit: number;
}

/** Resolves to the parsed JSON body: `[[t,o,h,l,c,v], ...]` or `{ bars: [...] }`. */
export type HistoryTransport = (query: HistoryQuery) => Promise<unknown>;

export interface HistoryPage {
  /** Ascending, de-duplicated. */
  readonly bars: readonly Bar[];
  /** Oldest `t` in this page — the cursor for the next, older page. */
  readonly cursor: TimeMs | null;
  /** Rows the codec rejected. Counted, never thrown (§3.1). */
  readonly dropped: number;
}

export interface HistoryRange {
  readonly sym: string;
  readonly tf: Timeframe;
  /** Newest bar wanted. `null` = latest. */
  readonly to?: TimeMs | null;
  /** Oldest bar wanted; paging stops once the cursor reaches it. */
  readonly from?: TimeMs | null;
  /** Cap on returned bars; the newest are kept. */
  readonly maxBars?: number;
  /** Per-page `limit`, clamped to `HISTORY_MAX_LIMIT`. */
  readonly pageLimit?: number;
}

export interface HistoryResult {
  /** Ascending, de-duplicated, frozen bars. */
  readonly bars: readonly Bar[];
  readonly pages: number;
  readonly dropped: number;
  /** `true` when the server ran out of history before the range was satisfied. */
  readonly exhausted: boolean;
}

export const clampLimit = (limit: number): number => {
  if (!Number.isFinite(limit)) return HISTORY_DEFAULT_LIMIT;
  return Math.min(HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit)));
};

/** Canonical request path; handy for a `fetch`-based transport in `app/`. */
export function historyPath(query: HistoryQuery): string {
  const parts = [
    `sym=${encodeURIComponent(query.sym)}`,
    `tf=${encodeURIComponent(query.tf)}`,
    `limit=${String(clampLimit(query.limit))}`,
  ];
  if (query.to !== null) parts.splice(2, 0, `to=${String(query.to)}`);
  return `/history?${parts.join('&')}`;
}

const rowsOf = (body: unknown): unknown => {
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null && 'bars' in body) {
    return (body as { readonly bars: unknown }).bars;
  }
  return null;
};

/** Ascending by `t`, later duplicates win (a re-fetched bar is the fresher one). */
function mergeAscending(bars: readonly Bar[]): readonly Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of bars) byTime.set(bar.t, bar);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export async function fetchHistoryPage(
  transport: HistoryTransport,
  query: HistoryQuery,
  codec: Codec = createCodec(),
): Promise<HistoryPage> {
  const before = codec.stats().dropped;
  const body = await transport(Object.freeze({ ...query, limit: clampLimit(query.limit) }));
  const rows = rowsOf(body);
  const bars = mergeAscending(codec.decodeRows(rows));
  const dropped = codec.stats().dropped - before;
  const cursor = bars.length > 0 ? bars[0].t : null;
  return Object.freeze<HistoryPage>({ bars, cursor, dropped });
}

/**
 * Walks descending pages until the range is covered, then returns one ascending
 * series. Paging stops on: an empty page, a short page (server exhausted), a
 * cursor that stopped moving, `from` reached, `maxBars` reached, or the page
 * guard — in that order of likelihood.
 */
export async function fetchHistory(
  transport: HistoryTransport,
  range: HistoryRange,
  codec: Codec = createCodec(),
): Promise<HistoryResult> {
  const limit = clampLimit(range.pageLimit ?? HISTORY_DEFAULT_LIMIT);
  const from = range.from ?? null;
  const maxBars = range.maxBars !== undefined && range.maxBars > 0 ? Math.floor(range.maxBars) : 0;

  const collected: Bar[] = [];
  let cursor: TimeMs | null = range.to ?? null;
  let pages = 0;
  let dropped = 0;
  let exhausted = false;

  while (pages < HISTORY_MAX_PAGES) {
    const page: HistoryPage = await fetchHistoryPage(
      transport,
      Object.freeze<HistoryQuery>({ sym: range.sym, tf: range.tf, to: cursor, limit }),
      codec,
    );
    pages += 1;
    dropped += page.dropped;
    collected.push(...page.bars);

    if (page.cursor === null || page.bars.length === 0) {
      exhausted = true;
      break;
    }
    if (page.bars.length < limit) {
      exhausted = true;
      break;
    }
    if (cursor !== null && page.cursor >= cursor) break; // no progress; bail out
    if (from !== null && page.cursor <= from) break;
    if (maxBars > 0 && collected.length >= maxBars) break;

    cursor = page.cursor;
  }

  let bars = mergeAscending(collected);
  if (from !== null) bars = bars.filter((bar) => bar.t >= from);
  if (maxBars > 0 && bars.length > maxBars) bars = bars.slice(bars.length - maxBars);

  return Object.freeze<HistoryResult>({ bars: Object.freeze(bars), pages, dropped, exhausted });
}

/**
 * Backfill for a sequence gap (ws/gapDetector.ts): everything from the last
 * known-good bar open up to and including `to`. Returns ascending bars for
 * `seriesStore.merge()`; the hole is filled with real bars or not at all.
 */
export async function backfillGap(
  transport: HistoryTransport,
  params: {
    readonly sym: string;
    readonly tf: Timeframe;
    readonly from: TimeMs;
    readonly to: TimeMs;
    readonly pageLimit?: number;
  },
  codec: Codec = createCodec(),
): Promise<HistoryResult> {
  return fetchHistory(
    transport,
    {
      sym: params.sym,
      tf: params.tf,
      to: asTimeMs(params.to),
      from: asTimeMs(params.from),
      ...(params.pageLimit !== undefined ? { pageLimit: params.pageLimit } : {}),
    },
    codec,
  );
}
