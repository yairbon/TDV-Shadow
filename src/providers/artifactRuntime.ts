/**
 * Detecting the claude.ai artifact runtime, and the provider it makes possible.
 *
 * The same bundle runs in two places with opposite network rules: served locally it can
 * reach any vendor over HTTPS and cannot reach a connector; published as an artifact it can
 * reach a connector and nothing else. Which one it is cannot be decided at build time, and
 * it cannot be decided synchronously either — `claude.use(name)` is a promise, and it is
 * the documented gate. So the app boots with the chain that works everywhere and upgrades
 * itself if the other world turns out to be the one it is in.
 *
 * `null` is returned for every negative case, and they are deliberately indistinguishable:
 * not published, published without the capability, capability failed to load. None of them
 * changes what the app should do, which is carry on with the chain it already has.
 */

import { createAlphaVantageMcpProvider, type McpCaller } from './alphaVantageMcp.js';
import type { MarketDataProvider } from './types.js';

/**
 * The one member of the runtime this file touches.
 *
 * Declared as an optional global rather than read off `window` with a cast, so that the
 * absence of the whole object — the normal case, everywhere except a published page — is
 * a type the compiler already understands.
 */
interface ClaudeRuntime {
  use(capability: string): Promise<unknown>;
}

function runtime(): ClaudeRuntime | null {
  // The entry point itself, not a capability's internals: `use()` is what decides whether
  // a capability is available, and probing past it is how a page ends up branching on
  // something the runtime never promised to keep.
  const host = (globalThis as { claude?: unknown }).claude;
  if (typeof host !== 'object' || host === null) return null;
  const use = (host as { use?: unknown }).use;
  return typeof use === 'function' ? (host as ClaudeRuntime) : null;
}

/** True when `value` can service the one call this app makes. */
function isCaller(value: unknown): value is McpCaller {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { callTool?: unknown }).callTool === 'function'
  );
}

/**
 * Resolves the connector-backed provider, or `null` when this is not a published page.
 *
 * Never rejects. A runtime that throws on `use` is the same outcome as one that is not
 * there, and a boot path that can throw would take the whole chart down with it.
 */
export async function detectConnectorProvider(): Promise<MarketDataProvider | null> {
  const host = runtime();
  if (host === null) return null;
  try {
    const namespace = await host.use('mcp');
    return isCaller(namespace) ? createAlphaVantageMcpProvider(namespace) : null;
  } catch {
    return null;
  }
}
