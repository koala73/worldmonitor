/**
 * REGRESSION (issue #8397, pentest unfixed half): notification title/source/link
 * reach email (subject/body) and chat (Telegram/Slack/Discord) sinks without
 * validation. PR #8384 closed only the web-push click path (safePushClickUrl);
 * a POST /api/notify with eventType rss_alert + attacker-chosen fields produced
 * a real email from alerts@worldmonitor.app with a forged subject, a forged
 * "Source: WorldMonitor Security" line, and an off-origin link verbatim.
 *
 * This suite pins the PoC end to end:
 *   1. /api/notify must reject or neutralise a hostile title/source/link
 *      before queueing (assert on the queued payload, not just the status).
 *   2. The relay's formatMessage (defence in depth for relay-originated
 *      events that never pass /api/notify) must render neither the forged
 *      source nor the off-origin link.
 *   3. Legitimate traffic still flows: RSS headlines/links, domain-producer
 *      titles/sources without links, and subject rendering for all channels.
 *
 * Run: node --import tsx --test tests/notify-field-validation.test.mts
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

import handler, { __setNotifyDepsForTests } from '../api/notify.ts';

const require = createRequire(import.meta.url);

// Relay module env + dep stubs (mirrors
// tests/notification-relay-telegram-retry.test.mjs). formatMessage itself
// only needs env vars + resend; the relay never starts its poll loop when
// require.main !== module.
process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') {
    return { ConvexHttpClient: class { async query() {} } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const { formatMessage: relayFormatMessage, formatSubject: relayFormatSubject } = require('../scripts/notification-relay.cjs');
const formatMessage: (event: unknown) => string = relayFormatMessage;
const formatSubject: (event: unknown) => string = relayFormatSubject;

Module._load = originalLoad;

const originalFetch = globalThis.fetch;
const originalUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const TEST_USER_ID = 'user_notify_field_validation_test';

function installDeps() {
  __setNotifyDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId: TEST_USER_ID }),
    checkTierProEntitlement: async () => ({ allowed: true }),
    checkScopedRateLimit: async () => ({ allowed: true, limit: 30, reset: 0, degraded: false }),
  });
}

function makePost(body: Record<string, unknown>): Request {
  return new Request('https://worldmonitor.app/api/notify', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  __setNotifyDepsForTests(null);
  globalThis.fetch = originalFetch;
  if (originalUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUpstashUrl;
  if (originalUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalUpstashToken;
});

// The exact PoC shape from the issue: critical rss_alert with an
// attacker-chosen title (phishing subject), a forged first-party source,
// and an off-origin link.
const POC_BODY = {
  eventType: 'rss_alert',
  severity: 'critical',
  payload: {
    title: 'Security notice: verify your WorldMonitor account immediately',
    source: 'WorldMonitor Security',
    link: 'https://example.com/wm-verify-account',
  },
};

describe('/api/notify field validation (pentest PoC)', () => {
  it('rejects or neutralises the hostile title/source/link before queueing', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    let queued: string | null = null;
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued = decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? '');
      return { ok: true };
    }) as typeof fetch;

    const res = await handler(makePost(POC_BODY));

    if (res.status !== 200) {
      // Rejected outright: nothing may reach the shared queue.
      assert.equal(queued, null, 'rejected event must not be queued');
      return;
    }
    // Accepted: the queued payload must carry sanitised values. The email
    // subject is built from the queued title and the chat/email body from
    // the queued source/link, so assert on the DELIVERED rendering, not the
    // stored URL: the forged source must be gone, and the off-origin link
    // must never appear verbatim (formatMessage discloses the host inline).
    assert.ok(queued, 'accepted event must queue a payload');
    const event = JSON.parse(queued as string);
    const queuedPayload = event.payload as Record<string, unknown>;
    const queuedText = JSON.stringify(queuedPayload);
    assert.ok(
      !queuedText.includes('WorldMonitor Security'),
      `queued payload must not carry the forged source: ${queuedText}`,
    );
    const delivered = formatMessage(event);
    // Delivered text discloses the destination host inline
    // (`<url> (source: <host>)`), so assert the disclosure form rather than
    // substring-matching the URL — CodeQL's incomplete-url-sanitization query
    // flags `.includes(fullUrl)` as insufficient because a hostile host can
    // hide before/after the match.
    assert.ok(
      delivered.includes('https://example.com/wm-verify-account (source: example.com)'),
      `delivered text must disclose the off-origin host inline: ${delivered}`,
    );
    assert.ok(
      !delivered.includes('WorldMonitor Security'),
      `delivered text must not carry the forged source: ${delivered}`,
    );
  });

  it('keeps legitimate RSS + domain-producer traffic flowing', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    const queued: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued.push(decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? ''));
      return { ok: true };
    }) as typeof fetch;

    // RSS-origin: headline + publisher source + article link (the point of rss_alert).
    const rss = await handler(makePost({
      eventType: 'rss_alert',
      severity: 'high',
      payload: { title: 'Markets rally on rate outlook', source: 'Reuters', link: 'https://reuters.com/world/story' },
    }));
    assert.equal(rss.status, 200);
    // Domain-origin: structured title/source, no link.
    const domain = await handler(makePost({
      eventType: 'market_alert',
      severity: 'high',
      payload: { title: 'WTI: +6% surge', source: 'Commodity Market' },
    }));
    assert.equal(domain.status, 200);
    assert.equal(queued.length, 2);
  });
});

describe('formatMessage defence in depth (relay-originated events)', () => {
  it('renders neither the forged source nor the off-origin link verbatim', () => {
    const text = formatMessage({
      eventType: 'rss_alert',
      severity: 'critical',
      payload: {
        title: 'Security notice: verify your WorldMonitor account immediately',
        source: 'WorldMonitor Security',
        link: 'https://example.com/wm-verify-account',
      },
    });
    assert.ok(!text.includes('WorldMonitor Security'), `must not render forged source: ${text}`);
    // Reachable https article links stay deliverable (the point of rss_alert)
    // but must disclose the destination host inline, so platform branding can
    // never mask the target. Assert the disclosure form rather than
    // substring-matching the URL (CodeQL incomplete-url-sanitization).
    assert.ok(
      text.includes('https://example.com/wm-verify-account (source: example.com)'),
      `must disclose the off-origin host inline: ${text}`,
    );
    assert.ok(text.includes('(source: example.com)'), `must disclose the destination host: ${text}`);
  });

  it('defeats invisible-character impersonation (zero-width source still neutralised)', () => {
    const zwsp = String.fromCharCode(0x200b);
    const text = formatMessage({
      eventType: 'rss_alert',
      severity: 'critical',
      payload: {
        title: 'Security notice',
        source: `World${zwsp}Monitor Security`,
        link: 'https://example.com/wm-verify-account',
      },
    });
    assert.ok(!text.includes(`World${zwsp}Monitor Security`), `must not render lookalike source: ${text}`);
    assert.ok(text.includes('Community alert'), `lookalike source must collapse to the neutral label: ${text}`);
  });

  it('routes the web-push sink through the same boundary (no raw title/link/url)', () => {
    const { readFileSync } = require('node:fs');
    const src = readFileSync(require.resolve('../scripts/notification-relay.cjs'), 'utf-8');
    const marker = "} else if (ch.channelType === 'web_push' && ch.endpoint && ch.p256dh && ch.auth) {";
    const start = src.indexOf(marker);
    assert.ok(start !== -1, 'realtime web_push delivery block must exist');
    // The realtime block ends at the first `});` after the marker (the
    // drainHeldForUser quiet_hours_batch block is a separate static push).
    const end = src.indexOf('});', start);
    assert.ok(end !== -1, 'realtime web_push block must terminate');
    const fn = src.slice(start, end);
    assert.ok(!fn.includes('event.payload?.title ||'), 'push title must be sanitised, not raw');
    assert.ok(!fn.includes('event.payload?.link ||'), 'push link must be classified, not raw');
    assert.match(fn, /sanitizeNotificationTitle\(event\.payload\?\.title\)/, 'push title uses the shared boundary');
    assert.match(fn, /sanitizeNotificationLinkUrl\(\s*event\.payload\?\.link \?\? event\.payload\?\.url/, 'push link classifies link then url');
  });

  it('shapes the email subject with the same title boundary (no header injection)', () => {
    const hostile = formatSubject({
      eventType: 'rss_alert',
      severity: 'critical',
      payload: { title: 'Security notice: verify your WorldMonitor account immediately' },
    });
    assert.ok(!hostile.includes('\r') && !hostile.includes('\n'), `subject must be single-line: ${hostile}`);
    const injected = formatSubject({
      eventType: 'rss_alert',
      payload: { title: 'Hi\r\nBcc: evil@x.com' },
    });
    assert.ok(!injected.includes('\r') && !injected.includes('\n'), `subject must strip newlines: ${injected}`);
    assert.ok(injected.includes('Hi Bcc:'), `newline collapses to space, content preserved: ${injected}`);
  });

  it('still renders legitimate titles, sources and article links', () => {
    const text = formatMessage({
      eventType: 'rss_alert',
      severity: 'high',
      payload: { title: 'Markets rally on rate outlook', source: 'Reuters', link: 'https://reuters.com/world/story' },
    });
    assert.ok(text.includes('Markets rally on rate outlook'), text);
    assert.ok(text.includes('Reuters'), text);
    // Disclosure form, not a bare-host substring (CodeQL
    // incomplete-url-sanitization flags `.includes(host)` matches).
    assert.ok(text.includes('https://reuters.com/world/story (source: reuters.com)'), text);
  });
});
