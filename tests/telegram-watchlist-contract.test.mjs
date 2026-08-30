import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Telegram custom-channel architecture (#1994)', () => {
  it('extends the credentialed feed route instead of creating parallel API endpoints', () => {
    assert.equal(existsSync(new URL('../api/telegram-resolve.js', import.meta.url)), false);
    assert.equal(existsSync(new URL('../api/telegram-channel.js', import.meta.url)), false);

    const edge = read('api/telegram-feed.js');
    assert.match(edge, /mode === 'resolve'/);
    assert.match(edge, /mode === 'channel'/);
    assert.match(edge, /relayPath = mode === 'resolve' \? '\/telegram\/resolve' : '\/telegram\/channel'/);
    assert.match(edge, /validateApiKey\(req\)/);
    assert.match(edge, /feed: \{ scope: 'telegram-feed:feed', limit: 60/);
    // Assert each mode has its OWN rate-limit scope, not a literal budget: the
    // numbers are tuning parameters (the channel budget has to clear
    // TELEGRAM_WATCHLIST_MAX_ENTRIES with headroom), and pinning them here made
    // a capacity fix look like an architecture violation.
    assert.match(edge, /resolve: \{ scope: 'telegram-feed:resolve', limit: \d+/);
    assert.match(edge, /channel: \{ scope: 'telegram-feed:channel', limit: \d+/);
    // This handler is `runtime: 'edge'` and never streams, so the platform
    // kills the invocation if it has not begun responding within 25s. Assert
    // the INVARIANT rather than three literals: pinning the exact values meant
    // the suite could stay green with a timeout that the platform would cut off
    // before the handler's own 504 envelope could ever be returned.
    const timeoutBlock = edge.match(/TELEGRAM_RELAY_TIMEOUT_MS = \{([\s\S]*?)\}/)?.[1];
    assert.ok(timeoutBlock, 'TELEGRAM_RELAY_TIMEOUT_MS must be a literal object');
    const timeouts = [...timeoutBlock.matchAll(/(\w+):\s*([\d_]+)/g)]
      .map(([, mode, value]) => [mode, Number(value.replace(/_/g, ''))]);
    assert.deepEqual(timeouts.map(([mode]) => mode).sort(), ['channel', 'feed', 'resolve']);
    for (const [mode, ms] of timeouts) {
      assert.ok(ms > 0, `${mode} timeout must be positive`);
      assert.ok(ms < 25_000, `${mode} relay timeout ${ms}ms must stay under the Edge 25s begin-response ceiling`);
    }
  });

  it('keeps product-managed channels separate and accepts only public Telegram channels', () => {
    const relay = read('scripts/ais-relay.cjs');
    const curatedStart = relay.indexOf('function loadTelegramChannels()');
    const customStart = relay.indexOf('async function resolveTelegramChannelWithConnection(normalized, connection)');
    const customEnd = relay.indexOf('let telegramPermanentlyDisabled', customStart);

    assert.ok(curatedStart >= 0 && customStart > curatedStart && customEnd > customStart);
    const customBlock = relay.slice(customStart, customEnd);
    assert.match(customBlock, /entity instanceof TelegramChannel/);
    assert.match(customBlock, /!entity\.username/);
    assert.match(customBlock, /withTelegramLookupSingleFlight/);
    assert.match(customBlock, /runTelegramRpc/);
    assert.doesNotMatch(customBlock, /telegramState\.channels\.(?:push|splice|unshift)/);
  });

  it('keeps Telegram post bodies out of shared HTTP caches', () => {
    const relay = read('scripts/ais-relay.cjs');
    const routeStart = relay.indexOf("pathname === '/telegram/channel'");
    const routeEnd = relay.indexOf("pathname === '/telegram' || pathname === '/telegram/feed'", routeStart);

    assert.ok(routeStart >= 0 && routeEnd > routeStart);
    const routeBlock = relay.slice(routeStart, routeEnd);
    assert.match(routeBlock, /'Cache-Control': 'no-store'/);
    assert.match(routeBlock, /'CDN-Cache-Control': 'no-store'/);
    assert.doesNotMatch(routeBlock, /'Cache-Control': 'public/);
  });
});
