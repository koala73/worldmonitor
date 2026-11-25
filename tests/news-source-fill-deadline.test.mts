/**
 * The source-fill deadline (src/app/news-source-fill.ts) covers the request,
 * not the wait for the lazily loaded RPC client code. On DebugBear's throttled
 * phone that chunk took 2.65s and the send left 4s after the call, so a
 * deadline set at the call aborted all ten fills before their 200s landed.
 *
 * AbortSignal.timeout is scaled down 100x here so the 5s budget runs as 50ms.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createLazyRpcClientConstructor } from '../src/services/generated-rpc-clients.ts';
import type { NewsServiceClient } from '../src/generated/client/worldmonitor/news/v1/service_client.ts';
import { createSourceItemsClient, fetchSourceItems } from '../src/app/news-source-fill.ts';

const SCALE = 100;
const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
const nativeFetch = globalThis.fetch;
const nativeWarn = console.warn;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function lazyNewsClient(loadMs: number): typeof NewsServiceClient {
  return createLazyRpcClientConstructor(async () => {
    await delay(loadMs);
    return (await import('../src/generated/client/worldmonitor/news/v1/service_client.ts')).NewsServiceClient;
  }) as unknown as typeof NewsServiceClient;
}

const BODY = JSON.stringify({
  items: [{ source: 'Rappler', title: 'Headline', link: 'https://example.test/a', publishedAt: Date.now(), isAlert: false }],
  sources: [{ source: 'Rappler', state: 'found', edition: 'full', items: 1 }],
  generatedAt: new Date().toISOString(),
});

/** A send that answers after `ms`, or rejects with the signal's reason once it aborts. */
function respondAfter(ms: number): typeof fetch {
  return (_input, init) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => resolve(new Response(BODY, { status: 200 })), ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

describe('fetchSourceItems deadline', () => {
  const warnings: unknown[][] = [];

  beforeEach(() => {
    warnings.length = 0;
    AbortSignal.timeout = (ms: number) => nativeTimeout(ms / SCALE);
    console.warn = (...args: unknown[]) => { warnings.push(args); };
  });

  afterEach(() => {
    AbortSignal.timeout = nativeTimeout;
    globalThis.fetch = nativeFetch;
    console.warn = nativeWarn;
  });

  it('starts when the request is sent, so a slow client load does not spend it', async () => {
    globalThis.fetch = respondAfter(5);
    const client = createSourceItemsClient(lazyNewsClient(150));

    const items = await fetchSourceItems(['full'], 'asia', ['Rappler'], 'en', client);

    assert.deepEqual(warnings, []);
    assert.deepEqual(items.map(item => item.source), ['Rappler']);
  });

  it('still bounds a send slower than the budget', async () => {
    globalThis.fetch = respondAfter(500);
    const client = createSourceItemsClient(lazyNewsClient(0));

    const items = await fetchSourceItems(['full'], 'asia', ['Rappler'], 'en', client);

    assert.deepEqual(items, []);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[1]), /TimeoutError/);
  });
});
