/**
 * Public surface of the data layer — the only thing `app/` needs to import.
 * (`renderer/` imports `data/types.js` and nothing else; ESLint enforces it.)
 */

export * from './types.js';
export { createCodec, toFiniteNumber, DROP_REASONS } from './codec.js';
export type { Codec, CodecStats, DropReason } from './codec.js';

export {
  BARS_CHANNEL,
  encodeClientMessage,
  isBarMessage,
  isPongMessage,
  parseServerMessage,
  pingMessage,
  subscribeMessage,
  subscriptionKey,
  unsubscribeMessage,
} from './ws/protocol.js';
export type {
  BarMessage,
  ClientMessage,
  ParsedServerMessage,
  ParseFailure,
  PongMessage,
  ServerMessage,
  Subscription,
} from './ws/protocol.js';

export { backoffDelayMs, createWsClient, DEFAULT_BACKOFF, WS_OPEN } from './ws/client.js';
export type {
  BackoffPolicy,
  BarEvent,
  ConnectionState,
  WebSocketFactory,
  WebSocketLike,
  WsClient,
  WsClientOptions,
} from './ws/client.js';

export { createGapDetector } from './ws/gapDetector.js';
export type { GapDetector, GapStats, SeqVerdict } from './ws/gapDetector.js';

export {
  backfillGap,
  clampLimit,
  fetchHistory,
  fetchHistoryPage,
  historyPath,
  HISTORY_MAX_LIMIT,
} from './rest/history.js';
export type { HistoryPage, HistoryQuery, HistoryResult, HistoryTransport } from './rest/history.js';

export { createSeriesStore } from './store/seriesStore.js';
export type { ApplyResult, SeriesStore } from './store/seriesStore.js';
export { createViewStore, DEFAULT_VIEW, MAX_BAR_SPACING, MIN_BAR_SPACING } from './store/viewStore.js';
export type { ViewState, ViewStore } from './store/viewStore.js';
export { createSnapshot, createSnapshotSource } from './store/snapshot.js';
export type { SnapshotSource } from './store/snapshot.js';
export { createTickBuffer } from './store/tickBuffer.js';
export type { FlushStats, PendingTick, StoreResolver, TickBuffer } from './store/tickBuffer.js';

export { canResample, foldIntoBucket, resample } from './agg/resample.js';

export { createBarPipeline } from './pipeline.js';
export type { BarPipeline, BarPipelineOptions, PipelineStats } from './pipeline.js';
