// The Playwright dev server must not reach the network from its own process
// (#11185 follow-up). e2e/dev-server-hermetic.spec.ts proves it through the
// real server; these pin the helper's edges.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  closeExternalProxyRules,
  installE2eOutboundFetchGuard,
  isLoopbackUrl,
} from '../shared/e2e-dev-network-guard.ts';

describe('isLoopbackUrl', () => {
  it('accepts loopback hosts only', () => {
    for (const url of ['http://127.0.0.1:4173/x', 'http://localhost/x', 'http://[::1]:8080/']) {
      assert.equal(isLoopbackUrl(url), true, url);
    }
    for (const url of ['https://feeds.bbci.co.uk/', 'https://127.0.0.1.evil.test/', 'not a url', '']) {
      assert.equal(isLoopbackUrl(url), false, url);
    }
  });
});

describe('installE2eOutboundFetchGuard', () => {
  function setup() {
    const calls: string[] = [];
    const warnings: string[] = [];
    const target = {
      fetch: (async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input instanceof Request ? input.url : input));
        return new Response('ok');
      }) as typeof fetch,
    };
    const restore = installE2eOutboundFetchGuard(target, (message) => warnings.push(message));
    return { target, calls, warnings, restore };
  }

  it('passes loopback requests through', async () => {
    const { target, calls } = setup();
    assert.equal(await (await target.fetch('http://127.0.0.1:4173/api/x')).text(), 'ok');
    assert.deepEqual(calls, ['http://127.0.0.1:4173/api/x']);
  });

  it('rejects string, URL and Request inputs to other hosts like a network failure', async () => {
    const { target, calls } = setup();
    for (const input of ['https://a.test/rss', new URL('https://b.test/'), new Request('https://c.test/')]) {
      await assert.rejects(target.fetch(input), (error: unknown) =>
        error instanceof TypeError && /^fetch failed: .*blocks outbound/.test(error.message));
    }
    assert.deepEqual(calls, []);
  });

  it('warns once per blocked host', async () => {
    const { target, warnings } = setup();
    await target.fetch('https://a.test/1').catch(() => {});
    await target.fetch('https://a.test/2').catch(() => {});
    await target.fetch('https://b.test/').catch(() => {});
    assert.deepEqual(warnings, [
      '[e2e-network-guard] blocked outbound request to a.test',
      '[e2e-network-guard] blocked outbound request to b.test',
    ]);
  });

  it('restores the original fetch', async () => {
    const { target, calls, restore } = setup();
    restore();
    await target.fetch('https://a.test/');
    assert.deepEqual(calls, ['https://a.test/']);
  });
});

describe('closeExternalProxyRules', () => {
  const rules = {
    '/api/yahoo': { target: 'https://query1.finance.yahoo.com', changeOrigin: true },
    '/ws/aisstream': { target: 'wss://stream.aisstream.io', ws: true },
    '/short': 'https://example.test',
    '/local': { target: 'http://127.0.0.1:3000' },
  };

  it('returns the rules untouched when disabled', () => {
    assert.equal(closeExternalProxyRules(false, rules), rules);
  });

  it('adds a refusing bypass to every external rule and keeps loopback rules', () => {
    const closed = closeExternalProxyRules(true, rules) as Record<string, { target?: string; bypass?: () => unknown }>;
    for (const context of ['/api/yahoo', '/ws/aisstream', '/short']) {
      assert.equal(closed[context]?.bypass?.(), false, context);
    }
    assert.equal(closed['/short']?.target, 'https://example.test');
    assert.equal(closed['/api/yahoo']?.target, 'https://query1.finance.yahoo.com');
    assert.equal(closed['/local'], rules['/local']);
  });
});
