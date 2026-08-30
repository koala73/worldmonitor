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
    assert.match(edge, /scope: 'telegram-feed'/);
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
