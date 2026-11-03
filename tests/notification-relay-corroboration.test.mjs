/**
 * #9213: a real-time alert states the story's corroboration on every channel.
 *
 * The relay's rss_alert carries the digest's publisher count
 * (`payload.corroborationCount`). Every text channel (Telegram, Slack,
 * Discord, email) sends formatMessage's text; web push sends a one-line body;
 * the webhook sends a structured `corroboration` field. A single-publisher
 * story must say so in the message itself.
 *
 * Run: node --test tests/notification-relay-corroboration.test.mjs
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';

function loadRelay() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, ...rest) {
    if (request === 'resend') return { Resend: class {} };
    return originalLoad.call(this, request, parent, ...rest);
  };
  const relayPath = require.resolve('../scripts/notification-relay.cjs');
  delete require.cache[relayPath];
  try {
    return require(relayPath);
  } finally {
    Module._load = originalLoad;
  }
}

const relay = loadRelay();

const rssAlert = (corroborationCount, extra = {}) => ({
  eventType: 'rss_alert',
  severity: 'high',
  payload: {
    title: 'Port strike halts container traffic',
    source: 'Reuters',
    link: 'https://www.reuters.com/world/port-strike',
    ...(corroborationCount === undefined ? {} : { corroborationCount }),
    ...extra,
  },
});

describe('formatMessage — the text every chat and email channel sends', () => {
  it('says a single-publisher story is single publisher', () => {
    const text = relay.formatMessage(rssAlert(1));
    assert.match(text, /^Source: Reuters · Coverage: single publisher$/m);
  });

  it('counts independent publishers for a corroborated story', () => {
    assert.match(relay.formatMessage(rssAlert(4)), /^Source: Reuters · Coverage: 4 independent publishers$/m);
  });

  it('states nothing when the event carries no count', () => {
    const text = relay.formatMessage(rssAlert(undefined));
    assert.match(text, /^Source: Reuters$/m);
    assert.doesNotMatch(text, /Coverage/);
  });

  it('stands alone when the event names no source', () => {
    const event = rssAlert(1);
    delete event.payload.source;
    assert.match(relay.formatMessage(event), /^Coverage: single publisher$/m);
  });

  it('ignores a count on a caller-submitted event, which /api/notify strips', () => {
    const text = relay.formatMessage({ ...rssAlert(9), userId: 'user_1' });
    assert.doesNotMatch(text, /Coverage/);
  });
});

describe('formatPushBody — the web push line', () => {
  it('carries the coverage token on the Source line', () => {
    const event = rssAlert(1);
    assert.equal(relay.formatPushBody(relay.formatMessage(event), event), 'Source: Reuters · Coverage: single publisher');
  });

  it('appends the token when the first line is a snippet', () => {
    const event = rssAlert(3);
    const text = '[HIGH] Port strike halts container traffic\n> Dockworkers walked out\nSource: Reuters · Coverage: 3 independent publishers';
    assert.equal(relay.formatPushBody(text, event), '> Dockworkers walked out · Coverage: 3 independent publishers');
  });

  it('leaves the body alone when the verdict is unknown', () => {
    const event = rssAlert(undefined);
    assert.equal(relay.formatPushBody('[HIGH] t\nSource: Reuters', event), 'Source: Reuters');
  });
});

describe('shapeEventForWebhook — the structured field', () => {
  it('adds corroboration {state, publishers} beside the count', () => {
    const shaped = relay.shapeEventForWebhook(rssAlert(1));
    assert.deepEqual(shaped.payload.corroboration, { state: 'single-publisher', publishers: 1 });
    assert.equal(shaped.payload.corroborationCount, 1);
    assert.deepEqual(relay.shapeEventForWebhook(rssAlert(5)).payload.corroboration, { state: 'corroborated', publishers: 5 });
  });

  it('omits it when unknown, and never forwards a caller-supplied value', () => {
    assert.equal('corroboration' in relay.shapeEventForWebhook(rssAlert(undefined)).payload, false);
    const forged = { ...rssAlert(undefined, { corroboration: { state: 'corroborated', publishers: 9 } }), userId: 'user_1' };
    assert.equal('corroboration' in relay.shapeEventForWebhook(forged).payload, false);
  });
});

describe('processEvent — an alert delivered to a channel', () => {
  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it('sends the single-publisher token in the Telegram message and the held batch', async () => {
    Object.assign(process.env, {
      CONVEX_SITE_URL: 'https://convex.test', TELEGRAM_BOT_TOKEN: 'fake', AI_IMPACT_ENABLED: '0',
    });
    const live = loadRelay();
    const sends = [];
    const held = [JSON.stringify(rssAlert(1))];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/relay/enabled-rules')) return Response.json([{
        userId: 'owner', variant: 'full', sensitivity: 'high', eventTypes: ['rss_alert'], channels: ['telegram'],
      }]);
      if (url.endsWith('/relay/channels')) {
        return Response.json([{ channelType: 'telegram', chatId: '12345', verified: true, telegramOwnership: 'verified_callback' }]);
      }
      if (url.includes('relay%3Aentitlement')) return Response.json({ result: '1' });
      if (url.includes('/LLEN/')) return Response.json({ result: held.length });
      if (url.includes('/LRANGE/')) return Response.json({ result: held });
      if (url.startsWith('https://api.telegram.org/')) {
        sends.push(JSON.parse(String(init?.body)).text);
        return Response.json({ ok: true });
      }
      return Response.json({ result: 'OK' });
    };
    await live.processEvent({ ...rssAlert(1, { importanceScore: 95 }), severity: 'critical' });
    assert.equal(sends.length, 1);
    assert.match(sends[0], /Coverage: single publisher/);

    await live.processEvent({ eventType: 'flush_quiet_held', userId: 'owner', variant: 'full' });
    assert.equal(sends.length, 2);
    assert.match(sends[1], /Port strike halts container traffic · Coverage: single publisher/);
  });
});

describe('Microsoft Teams cards (#9215 channel)', () => {
  const { buildTeamsNoticePayload } = require('../scripts/lib/notification-teams.cjs');
  const cardText = (payload) => JSON.stringify(payload.attachments[0].content.body);

  it('the real-time alert card states the coverage', () => {
    assert.match(cardText(relay.buildTeamsAlertForEvent(rssAlert(1))), /"Coverage: ".*"single publisher"/);
    assert.match(cardText(relay.buildTeamsAlertForEvent(rssAlert(3))), /"3 independent publishers"/);
    assert.doesNotMatch(cardText(relay.buildTeamsAlertForEvent(rssAlert(undefined))), /Coverage/);
  });

  it('the quiet-hours batch lines state the coverage', () => {
    const lines = relay.formatHeldAlertLines([rssAlert(1), rssAlert(undefined)]);
    assert.deepEqual(lines, [
      '[HIGH] Port strike halts container traffic · Coverage: single publisher',
      '[HIGH] Port strike halts container traffic',
    ]);
    assert.match(cardText(buildTeamsNoticePayload({ title: 'Held', lines })), /Coverage: single publisher/);
  });
});
