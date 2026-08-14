/**
 * Detecting the published-artifact runtime.
 *
 * This runs on every boot of every copy of the app, and the overwhelmingly common answer
 * is "not published". So the property that matters most is not that it finds the runtime —
 * it is that it never throws, never hangs, and never claims a provider it cannot use, on
 * any of the shapes `globalThis.claude` might present.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { detectConnectorProvider } from '../../../src/providers/artifactRuntime.js';

type Host = { claude?: unknown };

const host = globalThis as Host;

afterEach(() => {
  delete host.claude;
});

/** A runtime whose `use` answers `value` for the `mcp` capability. */
function runtimeServing(value: unknown): { use: (name: string) => Promise<unknown> } {
  return { use: (name: string) => Promise.resolve(name === 'mcp' ? value : null) };
}

describe('outside a published page', () => {
  it('resolves null when there is no runtime at all', async () => {
    expect(await detectConnectorProvider()).toBeNull();
  });

  it('resolves null when `claude` is present but not a runtime', async () => {
    // Something else on the page owning the name is not a reason to crash the chart.
    host.claude = 'not the runtime';
    expect(await detectConnectorProvider()).toBeNull();
    host.claude = {};
    expect(await detectConnectorProvider()).toBeNull();
  });
});

describe('inside a published page', () => {
  it('returns a provider when the capability resolves', async () => {
    host.claude = runtimeServing({ callTool: () => Promise.resolve({ payload: '' }) });
    const provider = await detectConnectorProvider();
    expect(provider).not.toBeNull();
    expect(provider?.capabilities().id).toBe('alpha-vantage-mcp');
  });

  it('resolves null when the capability is not granted', async () => {
    // `use` answering null is the documented way to say "not served here", and it is
    // deliberately indistinguishable from not being published — both mean carry on.
    host.claude = runtimeServing(null);
    expect(await detectConnectorProvider()).toBeNull();
  });

  it('resolves null when the namespace cannot make the one call this app needs', async () => {
    host.claude = runtimeServing({ listTools: () => Promise.resolve({ servers: [] }) });
    expect(await detectConnectorProvider()).toBeNull();
  });

  it('resolves null when `use` rejects', async () => {
    host.claude = {
      use: () => Promise.reject(new Error('capability failed to load')),
    };
    expect(await detectConnectorProvider()).toBeNull();
  });

  it('resolves null when `use` throws synchronously', async () => {
    // A boot path that can throw takes the whole chart down with it, and this one runs
    // before anything is drawn.
    host.claude = {
      use: () => {
        throw new Error('exploded');
      },
    };
    expect(await detectConnectorProvider()).toBeNull();
  });
});
