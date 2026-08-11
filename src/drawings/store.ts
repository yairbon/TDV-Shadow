/**
 * Drawing store — immutable updates, a revision counter the scheduler can key on, and
 * lossless JSON round-tripping so a chart's annotations outlive the page.
 */

import { DEFAULT_STYLE, TOOL_DEFINITIONS } from './tools.js';
import type { Anchor, Drawing, DrawingKind, DrawingStyle, MagnetTarget } from './types.js';

export interface DrawingStore {
  list(): readonly Drawing[];
  get(id: string): Drawing | null;
  add(
    kind: DrawingKind,
    anchors: readonly Anchor[],
    options?: {
      readonly style?: Partial<DrawingStyle>;
      readonly params?: Drawing['params'];
      readonly magnetTargets?: readonly MagnetTarget[];
    },
  ): Drawing;
  update(id: string, patch: Partial<Pick<Drawing, 'anchors' | 'style' | 'params' | 'locked' | 'visible'>>): Drawing | null;
  remove(id: string): boolean;
  clear(): number;
  select(id: string | null): void;
  selected(): string | null;
  revision(): number;
  toJSON(): string;
  loadJSON(json: string): number;
  subscribe(listener: () => void): () => void;
}

export function createDrawingStore(idSeed = 0): DrawingStore {
  let drawings: Drawing[] = [];
  let revision = 0;
  let nextId = idSeed;
  let selectedId: string | null = null;
  const listeners = new Set<() => void>();

  const bump = (): void => {
    revision += 1;
    for (const listener of listeners) listener();
  };

  const freeze = (drawing: Drawing): Drawing =>
    Object.freeze({
      ...drawing,
      anchors: Object.freeze([...drawing.anchors]),
      style: Object.freeze({ ...drawing.style, dash: Object.freeze([...drawing.style.dash]) }),
      params: Object.freeze({ ...drawing.params }),
      magnetTargets: Object.freeze([...drawing.magnetTargets]),
    });

  return {
    list: () => drawings,
    get: (id) => drawings.find((d) => d.id === id) ?? null,

    add(kind, anchors, options = {}) {
      nextId += 1;
      const drawing = freeze({
        id: `d${String(nextId)}`,
        kind,
        anchors: [...anchors],
        style: { ...DEFAULT_STYLE, ...options.style },
        locked: false,
        visible: true,
        params: { ...TOOL_DEFINITIONS[kind].defaults, ...options.params },
        magnetTargets: options.magnetTargets ?? anchors.map(() => null),
      });
      drawings = [...drawings, drawing];
      bump();
      return drawing;
    },

    update(id, patch) {
      const index = drawings.findIndex((d) => d.id === id);
      if (index < 0) return null;
      const current = drawings[index];
      if (current.locked) return current;
      const next = freeze({ ...current, ...patch });
      drawings = [...drawings.slice(0, index), next, ...drawings.slice(index + 1)];
      bump();
      return next;
    },

    remove(id) {
      const next = drawings.filter((d) => d.id !== id);
      if (next.length === drawings.length) return false;
      drawings = next;
      if (selectedId === id) selectedId = null;
      bump();
      return true;
    },

    clear() {
      const count = drawings.length;
      if (count === 0) return 0;
      drawings = [];
      selectedId = null;
      bump();
      return count;
    },

    select(id) {
      selectedId = id;
    },
    selected: () => selectedId,
    revision: () => revision,

    toJSON: () => JSON.stringify({ version: 1, drawings }),

    loadJSON(json) {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null) return 0;
      const list = (parsed as { drawings?: unknown }).drawings;
      if (!Array.isArray(list)) return 0;
      drawings = (list as Drawing[]).map((d) => freeze(d));
      // The counter must clear every restored id, or the next add would collide.
      for (const drawing of drawings) {
        const numeric = Number(drawing.id.replace(/^d/, ''));
        if (Number.isFinite(numeric)) nextId = Math.max(nextId, numeric);
      }
      bump();
      return drawings.length;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
