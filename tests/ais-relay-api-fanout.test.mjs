import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// Source-text guard for the relay side of the occurrence-event pipeline
// (shared/event-triggers.json: news.breaking, market.move). The relay process
// cannot be imported in a test (it opens sockets at load), so the contract is
// pinned the way tests/notification-relay-coalesce-key.test.mjs pins the
// coalesce keys: by reading scripts/ais-relay.cjs.

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const { API_FANOUT_EVENT_TYPES, API_FANOUT_LIST_KEY } = require('../scripts/lib/occurrence-events.cjs');

function blockAfter(marker, length = 1200) {
  const index = relaySrc.indexOf(marker);
  assert.notEqual(index, -1, `missing ${marker}`);
  return relaySrc.slice(index, index + length);
}

describe('ais-relay API fan-out tee', () => {
  it('requires the shared id module and tees only the fan-out event types after a confirmed queue push', () => {
    assert.match(relaySrc, /require\('\.\/lib\/occurrence-events\.cjs'\)/);
    const publish = blockAfter('async function publishNotificationEvent(', 3500);
    assert.match(publish, /const fanout = API_FANOUT_EVENT_TYPES\.has\(eventType\)/);
    // Id first, so the queue message and the tee copy are the same bytes.
    assert.ok(publish.indexOf('occurrenceEventIdFor(eventType, payload, publishedAt)') < publish.indexOf("upstashLpush('wm:events:queue', msg)"));
    // Tee after the LPUSH succeeded, inside the `ok` branch, before the log line.
    const okBranch = publish.slice(publish.indexOf('if (ok) {'));
    assert.ok(okBranch.indexOf('teeApiFanout(eventType, msg)') < okBranch.indexOf('[Notify] Queued'));
    assert.match(okBranch, /if \(fanout\) teeApiFanout\(eventType, msg\)/);
    assert.deepEqual([...API_FANOUT_EVENT_TYPES].sort(), ['market_alert', 'rss_alert']);
  });

  it('the tee is one EVAL that pushes, caps and expires the list, and never rejects into the publish path', () => {
    const tee = blockAfter('function teeApiFanout(', 700);
    assert.match(tee, /upstashEval\(API_FANOUT_TEE_SCRIPT, \[API_FANOUT_LIST_KEY\], \[msg, API_FANOUT_LIST_CAP, API_FANOUT_LIST_TTL_SECONDS\]\)/);
    assert.match(tee, /\.catch\(/, 'a tee failure is logged, not thrown');
    assert.equal(API_FANOUT_LIST_KEY, 'wm:events:api:v1');
  });

  it('the rss_alert publish site carries category and countryCodes (plural) beside the existing fields', () => {
    const site = blockAfter("eventType: 'rss_alert',", 900);
    for (const field of ['title: chunk[idx]', 'source: meta.source', 'link: meta.link', 'publishedAt: meta.publishedAt', 'importanceScore', 'corroborationCount', 'category,', 'countryCodes: matchCountryNamesInText(chunk[idx])']) {
      assert.ok(site.includes(field), `rss_alert payload must carry ${field}`);
    }
    assert.ok(!/payload:\s*\{[^}]*\bcountryCode:/s.test(site), 'rss_alert stays permissive-unattributed for relay country scopes: no singular countryCode');
  });

  it('all three market_alert publish sites carry the quote fields the market.move payload needs', () => {
    const blocks = [...relaySrc.matchAll(/eventType:\s*'market_alert'[\s\S]*?dedupTtl:\s*3600,/g)].map((m) => m[0]);
    assert.equal(blocks.length, 3, 'equity, commodity and crypto');
    for (const [block, assetClass] of blocks.map((b, i) => [b, ['equity', 'commodity', 'crypto'][i]])) {
      assert.match(block, new RegExp(`\\.\\.\\.marketMoveFields\\('${assetClass}', q\\)`), `${assetClass} site`);
      assert.match(block, /coalesceKey:\s*marketAlertCoalesceKey\(/);
    }
    const fields = blockAfter('function marketMoveFields(', 500);
    for (const key of ['assetClass', 'symbol:', 'name:', 'price:', 'changePct: q.change', "direction: q.change < 0 ? 'down' : 'up'"]) {
      assert.ok(fields.includes(key), `marketMoveFields must set ${key}`);
    }
    assert.match(fields, /toUpperCase\(\)/, 'symbols are upper-cased to match the stored subscription scope');
  });

  it('the Saudi Civil Defense path publishes through the same function, so it is teed with an id and no category', () => {
    const saudi = blockAfter('publishSaudiCivilDefenseAlerts(telegramState.items', 900);
    assert.match(saudi, /publish: \(event\) => publishNotificationEvent\(\{/);
    assert.ok(!saudi.includes('category:'), 'no classifier category on that path; the worker delivers category: null');
  });
});
