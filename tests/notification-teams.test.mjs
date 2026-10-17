// Microsoft Teams delivery channel (#9215): Adaptive Card payloads, the
// Microsoft-only URL guard at delivery, and dispatch from the realtime relay
// and the digest cron.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, it } from 'node:test';
import ts from 'typescript';
import { ALLOWED_CHANNELS } from '../scripts/lib/digest-delivered-log.mjs';

const require = createRequire(import.meta.url);
const https = require('node:https');
const teams = require('../scripts/lib/notification-teams.cjs');

const TEAMS_URL = 'https://abc123.12.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/0a1b2c/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=test';
const PUBLIC_IP = '20.42.65.92';

function cardOf(payload) {
  assert.equal(payload.type, 'message');
  assert.equal(payload.attachments.length, 1);
  const [attachment] = payload.attachments;
  assert.equal(attachment.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(attachment.contentUrl, null);
  assert.equal(attachment.content.type, 'AdaptiveCard');
  assert.equal(attachment.content.version, '1.2');
  return attachment.content;
}

// Every string a viewer reads, with the element type that renders it.
function textNodes(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) textNodes(n, out); return out; }
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'TextBlock' || node.type === 'TextRun') out.push({ type: node.type, text: node.text });
  for (const value of Object.values(node)) if (value && typeof value === 'object') textNodes(value, out);
  return out;
}

function renderedText(card) {
  return textNodes(card.body).map(n => n.text).join(' | ');
}

describe('Teams Adaptive Card payloads', () => {
  it('alert card carries title, severity, country, source and the original-report link', () => {
    const card = cardOf(teams.buildTeamsAlertPayload({
      title: 'Missile strike reported near Isfahan',
      severity: 'critical',
      countryCode: 'IR',
      source: 'Reuters',
      eventType: 'conflict_escalation',
      link: 'https://www.reuters.com/world/story-1',
    }));
    const text = renderedText(card);
    assert.match(text, /Missile strike reported near Isfahan/);
    assert.match(text, /CRITICAL/);
    assert.match(text, /Iran \(IR\)/);
    assert.match(text, /Reuters/);
    assert.deepEqual(card.actions, [{
      type: 'Action.OpenUrl',
      title: 'Open original report (www.reuters.com)',
      url: 'https://www.reuters.com/world/story-1',
    }]);
  });

  it('untrusted text never reaches a Markdown-rendering element', () => {
    const hostile = '[verify your account](https://evil.example) **now**';
    const card = cardOf(teams.buildTeamsAlertPayload({
      title: hostile, severity: 'high', source: hostile, description: hostile, impact: hostile,
    }));
    for (const node of textNodes(card.body)) {
      if (node.text.includes('evil.example')) {
        assert.equal(node.type, 'TextRun', `untrusted text rendered by ${node.type}: ${node.text}`);
      }
    }
    assert.equal(card.actions, undefined, 'no link means no button');
    const digest = cardOf(teams.buildTeamsDigestPayload({
      title: 'Digest', summary: hostile, stories: [{ title: hostile, severity: 'high', sources: [hostile] }],
    }));
    for (const node of textNodes(digest.body)) {
      if (node.text.includes('evil.example')) assert.equal(node.type, 'TextRun');
    }
  });

  it('a non-https or unparseable link falls back to the dashboard button', () => {
    const card = cardOf(teams.buildTeamsAlertPayload({ title: 't', severity: 'high', link: 'javascript:alert(1)' }));
    assert.deepEqual(card.actions, [{ type: 'Action.OpenUrl', title: 'Open WorldMonitor', url: 'https://worldmonitor.app/' }]);
  });

  it('a first-party link does not repeat the host', () => {
    const card = cardOf(teams.buildTeamsAlertPayload({ title: 't', link: 'https://www.worldmonitor.app/x' }));
    assert.equal(card.actions[0].title, 'Open original report');
  });

  it('splits a notice that would exceed the Teams limit into cards that each fit, losing no line', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `[HIGH] Line ${String(i).padStart(3, '0')} ${'y'.repeat(200)}`);
    const payloads = teams.buildTeamsNoticePayloads({ title: 'Batch', lines });
    assert.ok(payloads.length > 1);
    const seen = [];
    payloads.forEach((payload, i) => {
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= teams.TEAMS_MAX_PAYLOAD_BYTES);
      const text = renderedText(cardOf(payload));
      assert.match(text, new RegExp(`Batch \\(part ${i + 1} of ${payloads.length}\\)`));
      seen.push(...(text.match(/Line \d{3}/g) ?? []));
    });
    assert.deepEqual(seen, lines.map((_, i) => `Line ${String(i).padStart(3, '0')}`), 'every line, in order, exactly once');
    const small = teams.buildTeamsNoticePayloads({ title: 'Batch', lines: ['one', 'two'] });
    assert.equal(small.length, 1);
    assert.doesNotMatch(renderedText(cardOf(small[0])), /part/);
  });

  it('alert and digest cards state coverage from the corroboration verdict (#9213)', () => {
    const alert = renderedText(cardOf(teams.buildTeamsAlertPayload({ title: 't', severity: 'high', coverage: '3 independent publishers' })));
    assert.match(alert, /Coverage: {2}\| 3 independent publishers/);
    const digest = renderedText(cardOf(teams.buildTeamsDigestPayload({
      title: 'Digest',
      stories: [
        { title: 'Wide story', severity: 'high', sources: ['Reuters', 'AP'], corroboration: { state: 'corroborated', publishers: 2 } },
        { title: 'Lone story', severity: 'high', sources: ['BBC'], corroboration: 'single-publisher|1' },
        { title: 'Unknown story', severity: 'high', sources: ['AFP'] },
      ],
    })));
    assert.match(digest, /Reuters, AP · 2 independent publishers/);
    assert.match(digest, /BBC · single publisher/);
    assert.match(digest, /AFP( \||$)/);
    assert.doesNotMatch(digest, /AFP ·/);
  });

  it('an unresolvable country is omitted rather than guessed', () => {
    assert.equal(teams.describeCountry('Iran'), null);
    assert.equal(teams.describeCountry(undefined), null);
    assert.equal(teams.describeCountry('us'), 'United States (US)');
  });

  it('digest card lists stories, the summary, and the brief link', () => {
    const card = cardOf(teams.buildTeamsDigestPayload({
      title: 'WorldMonitor Daily Digest — October 17, 2026',
      summary: 'Two theatres escalated overnight.',
      stories: [
        { title: 'Story one', severity: 'critical', sources: ['Reuters', 'AP', 'BBC', 'AFP'] },
        { title: 'Story two', severity: 'high', sources: [] },
      ],
      briefUrl: 'https://www.worldmonitor.app/brief/abc',
    }));
    const text = renderedText(card);
    assert.match(text, /Executive summary/);
    assert.match(text, /Two theatres escalated overnight/);
    assert.match(text, /Story one/);
    assert.match(text, /Reuters, AP, BBC \+1/);
    assert.match(text, /Story two/);
    assert.equal(card.actions[0].title, 'Open your WorldMonitor Brief');
    assert.equal(card.actions[0].url, 'https://www.worldmonitor.app/brief/abc');
  });

  it('digest card drops stories from the end to stay under the 28 KB Teams limit', () => {
    const stories = Array.from({ length: 400 }, (_, i) => ({ title: `Story ${i} ${'x'.repeat(150)}`, severity: 'high', sources: ['Reuters'] }));
    const payload = teams.buildTeamsDigestPayload({ title: 'Digest', stories });
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= teams.TEAMS_MAX_PAYLOAD_BYTES);
    const text = renderedText(cardOf(payload));
    assert.match(text, /Story 0 /);
    assert.match(text, /more in the full brief/);
    assert.match(text, /400 stories/);
  });
});

describe('sendTeamsPayload network guard', () => {
  const realRequest = https.request;
  afterEach(() => { https.request = realRequest; });

  function answerWith(statusCode, headers = {}) {
    const calls = [];
    https.request = (options, onResponse) => {
      calls.push(options);
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => true;
      req.destroy = (error) => { if (error) req.emit('error', error); };
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.statusMessage = 'x';
        res.headers = headers;
        onResponse(res);
        res.emit('end');
      };
      return req;
    };
    return calls;
  }

  const resolvePublic = async () => [PUBLIC_IP];

  it('delivers to a Workflows URL over a connection pinned to the vetted address', async () => {
    const calls = answerWith(202);
    const result = await teams.sendTeamsPayload(TEAMS_URL, { type: 'message', attachments: [] }, { resolveHostname: resolvePublic });
    assert.deepEqual(result, { ok: true, status: 202, gone: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, 'abc123.12.environment.api.powerplatform.com');
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].path, /^\/powerautomate\/automations\/direct\/workflows\//);
    const pinned = await new Promise((resolve) => calls[0].lookup('ignored', {}, (_e, address) => resolve(address)));
    assert.equal(pinned, PUBLIC_IP);
  });

  it('refuses a non-Microsoft host before any DNS or network call', async () => {
    const calls = answerWith(200);
    let resolved = 0;
    const result = await teams.sendTeamsPayload('https://hooks.example.com/powerautomate/automations/direct/x', {}, {
      resolveHostname: async () => { resolved++; return [PUBLIC_IP]; },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /Workflows webhook/);
    assert.equal(resolved, 0);
    assert.equal(calls.length, 0);
  });

  it('refuses an IP literal', async () => {
    const calls = answerWith(200);
    const result = await teams.sendTeamsPayload('https://20.42.65.92/workflows/x/triggers/manual/paths/invoke', {}, { resolveHostname: resolvePublic });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });

  it('refuses a Microsoft hostname that resolves to a private address', async () => {
    const calls = answerWith(200);
    const result = await teams.sendTeamsPayload(TEAMS_URL, {}, { resolveHostname: async () => ['10.0.0.5'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /private\/reserved/);
    assert.equal(calls.length, 0);
  });

  it('does not follow a redirect', async () => {
    const calls = answerWith(302, { location: 'http://169.254.169.254/latest/meta-data' });
    const result = await teams.sendTeamsPayload(TEAMS_URL, {}, { resolveHostname: resolvePublic });
    assert.equal(result.ok, false);
    assert.equal(result.status, 302);
    assert.equal(result.gone, false);
    assert.equal(calls.length, 1, 'only the original request is made');
  });

  it('reports a deleted workflow as gone', async () => {
    answerWith(404);
    const result = await teams.sendTeamsPayload(TEAMS_URL, {}, { resolveHostname: resolvePublic });
    assert.deepEqual(result, { ok: false, status: 404, gone: true, error: 'HTTP 404' });
  });
});

// ── Dispatch ──────────────────────────────────────────────────────────────────

function loadRelayWithTeamsStub(posts, { status = 202 } = {}) {
  const ssrf = require('../scripts/lib/notification-webhook-ssrf.cjs');
  const saved = {
    assert: ssrf.assertNotificationWebhookDeliveryUrlSafe,
    post: ssrf.postJsonWithPinnedAddress,
  };
  ssrf.assertNotificationWebhookDeliveryUrlSafe = async (url) => ({ url: new URL(url), resolvedAddresses: [PUBLIC_IP] });
  ssrf.postJsonWithPinnedAddress = async (url, body) => {
    posts.push({ url: url.href, body: JSON.parse(body) });
    const current = Array.isArray(status) ? status[Math.min(posts.length - 1, status.length - 1)] : status;
    return new Response(null, { status: current });
  };
  const loader = Module;
  const originalLoad = loader._load;
  loader._load = function patchedLoad(name, ...args) {
    if (name === 'resend') return { Resend: class {} };
    return originalLoad.call(this, name, ...args);
  };
  const relayPath = require.resolve('../scripts/notification-relay.cjs');
  delete require.cache[relayPath];
  try {
    return { relay: require(relayPath), restore: () => { ssrf.assertNotificationWebhookDeliveryUrlSafe = saved.assert; ssrf.postJsonWithPinnedAddress = saved.post; } };
  } finally {
    loader._load = originalLoad;
  }
}

describe('realtime relay Teams dispatch', () => {
  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let restore = () => {};
  afterEach(() => {
    restore();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function setup({ status = 202, rule = {}, heldEvents = [{ eventType: 'conflict_escalation', severity: 'high', payload: { title: 'Held alert' } }] } = {}) {
    Object.assign(process.env, {
      UPSTASH_REDIS_REST_URL: 'https://upstash.test', UPSTASH_REDIS_REST_TOKEN: 'fake',
      CONVEX_URL: 'https://convex.test', CONVEX_SITE_URL: 'https://convex.test',
      CONVEX_NOTIFICATION_RELAY_SECRET: 'fake', AI_IMPACT_ENABLED: '0',
      NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    });
    const crypto = require('../scripts/lib/crypto.cjs');
    const posts = [];
    const loaded = loadRelayWithTeamsStub(posts, { status });
    restore = loaded.restore;
    const channel = { _id: 'teams-channel', channelType: 'teams', webhookEnvelope: crypto.encrypt(TEAMS_URL), verified: true };
    const deactivations = [];
    const held = [];
    const deletedHeld = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/relay/enabled-rules')) return Response.json([{
        userId: 'owner', variant: 'full', sensitivity: 'all', eventTypes: ['conflict_escalation'], channels: ['teams'], ...rule,
      }]);
      if (url.endsWith('/relay/channels')) return Response.json([channel]);
      if (url.endsWith('/relay/deactivate')) { deactivations.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
      if (url.includes('/GET/relay%3Aentitlement')) return Response.json({ result: '1' });
      if (url.includes('/RPUSH/') || url.includes('/LPUSH/')) { held.push(url); return Response.json({ result: 1 }); }
      if (url.includes('/LLEN/')) return Response.json({ result: 1 });
      if (url.includes('/LRANGE/')) return Response.json({ result: heldEvents.map(ev => JSON.stringify(ev)) });
      if (url.includes('/DEL/')) { deletedHeld.push(url); return Response.json({ result: 1 }); }
      return Response.json({ result: 'OK' });
    };
    return { relay: loaded.relay, posts, deactivations, held, deletedHeld };
  }

  it('delivers a matching event to the Teams channel as an Adaptive Card', async () => {
    const { relay, posts } = setup();
    await relay.processEvent({
      eventType: 'conflict_escalation', severity: 'critical',
      payload: { title: 'Synthetic escalation', countryCode: 'IR', source: 'Reuters', link: 'https://www.reuters.com/x', corroborationCount: 3 },
    });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, TEAMS_URL);
    const card = cardOf(posts[0].body);
    assert.match(renderedText(card), /Synthetic escalation/);
    assert.match(renderedText(card), /Iran \(IR\)/);
    assert.match(renderedText(card), /Coverage: {2}\| 3 independent publishers/);
    assert.equal(card.actions[0].url, 'https://www.reuters.com/x');
  });

  it('applies the rule country scope to Teams like every other channel', async () => {
    const { relay, posts } = setup({ rule: { countries: ['US'] } });
    await relay.processEvent({ eventType: 'conflict_escalation', severity: 'critical', payload: { title: 'Elsewhere', countryCode: 'IR' } });
    assert.equal(posts.length, 0);
  });

  it('deactivates the channel when the workflow is gone', async () => {
    const { relay, deactivations } = setup({ status: 404 });
    await relay.processEvent({ eventType: 'conflict_escalation', severity: 'critical', payload: { title: 'Gone' } });
    assert.deepEqual(deactivations, [{ userId: 'owner', channelType: 'teams' }]);
  });

  it('sends the connect/test welcome card to the exact Teams channel', async () => {
    const { relay, posts } = setup();
    await relay.processWelcome({ userId: 'owner', channelType: 'teams', welcomeId: 'teams-channel' });
    assert.equal(posts.length, 1);
    assert.match(renderedText(cardOf(posts[0].body)), /WorldMonitor connected/);
    await relay.processWelcome({ userId: 'owner', channelType: 'teams', welcomeId: 'some-other-channel' });
    assert.equal(posts.length, 1, 'a welcome for a replaced channel is not delivered');
  });

  it('drains quiet-hours held alerts to Teams', async () => {
    const { relay, posts } = setup();
    await relay.processEvent({ eventType: 'flush_quiet_held', userId: 'owner', variant: 'full' });
    assert.equal(posts.length, 1);
    const text = renderedText(cardOf(posts[0].body));
    assert.match(text, /1 held alert/);
    assert.match(text, /Held alert/);
  });

  it('delivers every alert of a full quiet-hours batch of long titles, across cards that fit', async () => {
    const heldEvents = Array.from({ length: 100 }, (_, i) => ({
      eventType: 'conflict_escalation', severity: 'high', payload: { title: `Held ${String(i).padStart(3, '0')} ${'x'.repeat(190)}` },
    }));
    const { relay, posts, deletedHeld } = setup({ heldEvents });
    await relay.processEvent({ eventType: 'flush_quiet_held', userId: 'owner', variant: 'full' });
    assert.ok(posts.length > 1, 'the batch is split, not refused as oversized');
    const delivered = [];
    for (const post of posts) {
      assert.ok(Buffer.byteLength(JSON.stringify(post.body)) <= teams.TEAMS_MAX_PAYLOAD_BYTES);
      const text = renderedText(cardOf(post.body));
      assert.match(text, /100 held alerts/);
      delivered.push(...(text.match(/Held \d{3}/g) ?? []));
    }
    assert.equal(delivered.length, 100, 'no held alert is dropped before the queue is cleared');
    assert.equal(new Set(delivered).size, 100);
    assert.equal(deletedHeld.length, 1, 'a delivered batch clears the held queue');
  });

  it('keeps the held queue when a later card of the batch fails', async () => {
    const heldEvents = Array.from({ length: 100 }, (_, i) => ({
      eventType: 'conflict_escalation', severity: 'high', payload: { title: `Held ${String(i).padStart(3, '0')} ${'x'.repeat(190)}` },
    }));
    const { relay, posts, deletedHeld } = setup({ heldEvents, status: [202, 500] });
    await relay.processEvent({ eventType: 'flush_quiet_held', userId: 'owner', variant: 'full' });
    assert.ok(posts.length >= 2);
    assert.equal(deletedHeld.length, 0, 'a partly delivered Teams batch is retried, not dropped');
  });
});

describe('digest cron Teams dispatch', () => {
  const source = readFileSync(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('digest.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function productionFunction(name) {
    const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn, `production function ${name} must exist`);
    return fn.getText(parsed);
  }

  async function runDigest({ channel, status = 202 }) {
    const sends = [];
    const deactivations = [];
    const metadata = [];
    const run = runInNewContext(['main', 'sendTeams'].map(productionFunction).join('\n') + '\nmain', {
      Date, Map, Set, Intl, AbortSignal, Buffer, process: { env: {} }, console: { log() {}, warn() {} },
      DIGEST_EMAIL_MAX_HTML_BYTES: 100_000,
      CONVEX_SITE_URL: 'https://convex.test', RELAY_SECRET: 'fake', DIGEST_LOOKBACK_MS: 86400000,
      AI_DIGEST_ENABLED: false,
      scanAndEnqueueWatchlistStoryEvents: async () => {},
      fetch: async (url) => {
        if (url.endsWith('/relay/digest-rules')) return Response.json([{ userId: 'owner', variant: 'full', channels: ['teams'] }]);
        if (url.endsWith('/relay/channels')) return Response.json([channel]);
        throw new Error(`unexpected fetch ${url}`);
      },
      decrypt: (envelope) => envelope.replace(/^enc:/, ''),
      deactivateChannel: async (userId, channelType) => { deactivations.push({ userId, channelType }); },
      buildTeamsDigestPayload: teams.buildTeamsDigestPayload,
      stripSourceSuffix: (title) => title.replace(/ - Reuters$/, ''),
      sendTeamsPayload: async (url, payload) => { sends.push({ url, payload }); return { ok: status < 300, status, gone: status === 404 }; },
      parseDigestOnlyUser: () => ({ kind: 'unset' }),
      composeBriefsForRun: async () => ({ briefByUser: new Map(), composeSuccess: 0, composeFailed: 0 }),
      readCooldownConfig: () => ({ invalidRaw: null, mode: 'off' }),
      getLastSentAt: async () => 0, isDue: () => true, isUserPro: async () => true,
      digestWindowStartMs: () => 0,
      buildDigest: async () => [{ title: 'Synthetic digest story - Reuters', severity: 'critical', sources: ['Reuters'] }],
      buildDigestDeliveryPlan: ({ rawStories }) => ({ formatterStories: rawStories, cooldownIterableStories: [], sourceCountByClusterId: new Map() }),
      formatDigest: () => 'WorldMonitor Daily Digest — October 17, 2026\n\nSynthetic digest story',
      renderDigestEmailHtml: () => ({ html: '<p>x</p>', bytes: 0, truncated: false, shownStories: 1 }),
      buildChannelBodies: (text) => ({ text, telegramText: text, slackText: text, discordText: text }),
      subjectForBrief: () => 'Synthetic digest', issueSlotInTz: () => 'test-slot',
      emitCooldownShadowLog: () => {}, upstashRest: async () => 'OK',
      shouldExitOnBriefFailures: () => false,
      writeDigestLastRunMeta: async (meta) => { metadata.push(meta); },
    });
    await run();
    return { sends, deactivations, metadata };
  }

  const verified = { _id: 'teams-channel', channelType: 'teams', webhookEnvelope: `enc:${TEAMS_URL}`, verified: true };

  it('delivers the digest to a verified Teams channel as an Adaptive Card', async () => {
    const { sends, metadata } = await runDigest({ channel: verified });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].url, TEAMS_URL);
    const text = renderedText(cardOf(sends[0].payload));
    assert.match(text, /WorldMonitor Daily Digest — October 17, 2026/);
    assert.match(text, /Synthetic digest story/);
    assert.doesNotMatch(text, /Synthetic digest story - Reuters/, 'titles get the formatDigest source-suffix strip');
    assert.equal(metadata[0].sentCount, 1);
  });

  it('records Teams digest deliveries in the cooldown log', () => {
    assert.ok(ALLOWED_CHANNELS.has('teams'), 'a Teams delivery must be loggable or the cooldown never sees it');
  });

  it('skips an unverified Teams channel', async () => {
    const { sends } = await runDigest({ channel: { ...verified, verified: false } });
    assert.equal(sends.length, 0);
  });

  it('deactivates a Teams channel whose workflow is gone', async () => {
    const { deactivations, metadata } = await runDigest({ channel: verified, status: 404 });
    assert.deepEqual(deactivations, [{ userId: 'owner', channelType: 'teams' }]);
    assert.equal(metadata[0].sentCount, 0);
  });
});
