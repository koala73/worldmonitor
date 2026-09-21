/**
 * REGRESSION (issue #8397, pentest unfixed half): notification title/source/link
 * reach email (subject/body) and chat (Telegram/Slack/Discord) sinks without
 * validation. PR #8384 closed only the web-push click path;
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

const {
  buildDiscordMessagePayload: relayBuildDiscordMessagePayload,
  buildSlackMessagePayload: relayBuildSlackMessagePayload,
  escapeDiscordText: relayEscapeDiscordText,
  escapeSlackText: relayEscapeSlackText,
  formatEventTitle: relayFormatEventTitle,
  formatEventLinkForPush: relayFormatEventLinkForPush,
  formatMessage: relayFormatMessage,
  formatSubject: relayFormatSubject,
  sanitizeImpactText: relaySanitizeImpactText,
  shapeEventForWebhook: relayShapeEventForWebhook,
} = require('../scripts/notification-relay.cjs');
const formatMessage: (event: unknown) => string = relayFormatMessage;
const formatSubject: (event: unknown) => string = relayFormatSubject;
const formatEventTitle: (event: unknown, fallback?: string) => string = relayFormatEventTitle;
// The web-push click target is the one sink that derives its own link, so it
// is asserted directly rather than through formatMessage (review finding: it
// was the only call site with no test).
const formatEventLinkForPush: (event: unknown) => string = relayFormatEventLinkForPush;
const sanitizeImpactText: (value: unknown) => string = relaySanitizeImpactText;
const shapeEventForWebhook: (event: unknown) => { payload: Record<string, unknown> } = relayShapeEventForWebhook;
const escapeSlackText: (text: string) => string = relayEscapeSlackText;
const escapeDiscordText: (text: string) => string = relayEscapeDiscordText;
const buildSlackMessagePayload: (text: string) => Record<string, unknown> = relayBuildSlackMessagePayload;
const buildDiscordMessagePayload: (text: string) => Record<string, unknown> = relayBuildDiscordMessagePayload;

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
      assert.ok(res.status >= 400 && res.status < 500, `rejection must be a client error, got ${res.status}`);
      assert.equal(queued, null, 'rejected event must not be queued');
      return;
    }
    // Accepted: the queued payload must carry sanitised values. The email
    // subject is built from the queued title and the chat/email body from
    // the queued source/link, so assert both queue and delivery values.
    assert.ok(queued, 'accepted event must queue a payload');
    const event = JSON.parse(queued as string);
    const queuedPayload = event.payload as Record<string, unknown>;
    const queuedText = JSON.stringify(queuedPayload);
    assert.ok(
      !queuedText.includes('WorldMonitor Security'),
      `queued payload must not carry the forged source: ${queuedText}`,
    );
    // The forged first-party identity is replaced; the off-origin link is
    // KEPT but can only be delivered with its destination host disclosed.
    assert.equal(queuedPayload.source, 'Community alert');
    assert.equal(queuedPayload.link, 'https://example.com/wm-verify-account');
    assert.equal(
      queuedPayload.title,
      'Community alert: Security notice: verify your WorldMonitor account immediately',
    );
    const delivered = formatMessage(event);
    assert.equal(
      delivered,
      '[CRITICAL] Community alert: Security notice: verify your WorldMonitor account immediately\n'
        + 'Source: Community alert\n'
        + 'https://example.com/wm-verify-account (source: example.com)',
    );
    // The push click target has no room for that disclosure, so a caller's
    // off-origin link never becomes a click target.
    assert.equal(formatEventLinkForPush(event), 'https://worldmonitor.app/');
    const subject = formatSubject(event);
    assert.ok(subject.startsWith('Community alert:'), subject);
    assert.ok(!subject.startsWith('WorldMonitor Alert:'), subject);
  });

  it('reports every field it rewrote back to the caller', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;

    const hostile = await handler(makePost(POC_BODY));
    assert.equal(hostile.status, 200);
    const body = await hostile.json() as { ok: boolean; warnings?: string[] };
    assert.equal(body.ok, true);
    assert.ok(body.warnings?.includes('source_rewritten'), JSON.stringify(body));
    assert.ok(body.warnings?.includes('title_rewritten'), JSON.stringify(body));

    // A payload the boundary leaves alone reports nothing, so existing
    // callers that ignore unknown fields see no change.
    const clean = await handler(makePost({
      eventType: 'rss_alert',
      payload: { title: 'Community alert: Markets rally', source: 'Reuters', link: 'https://reuters.com/a' },
    }));
    assert.equal(clean.status, 200);
    assert.deepEqual(await clean.json(), { ok: true });
  });

  it('keeps legitimate caller titles and first-party links flowing', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    const queued: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued.push(decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? ''));
      return { ok: true };
    }) as typeof fetch;

    // Caller-origin: title plus a first-party article link.
    const rss = await handler(makePost({
      eventType: 'rss_alert',
      severity: 'high',
      payload: { title: 'Markets rally on rate outlook', source: 'Reuters', link: 'https://worldmonitor.app/world/story' },
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
    // Real publisher attribution survives: only an IMPERSONATING source is
    // neutralised. The platform's own RSS forwarder posts through this
    // endpoint, so blanket neutralisation destroyed first-party attribution.
    const rssEvent = JSON.parse(queued[0]);
    assert.equal(rssEvent.payload.title, 'Community alert: Markets rally on rate outlook');
    assert.equal(rssEvent.payload.source, 'Reuters');
    assert.equal(rssEvent.payload.link, 'https://worldmonitor.app/world/story');
    const domainEvent = JSON.parse(queued[1]);
    assert.equal(domainEvent.payload.title, 'Community alert: WTI: +6% surge');
    assert.equal(domainEvent.payload.source, 'Commodity Market');
  });

  it('keeps a real off-origin article link and discloses its host on delivery', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    let queued = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued = decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? '');
      return { ok: true };
    }) as typeof fetch;

    const res = await handler(makePost({
      eventType: 'rss_alert',
      severity: 'high',
      payload: { title: 'Markets rally', source: 'Reuters', link: 'https://reuters.com/world/story' },
    }));
    assert.equal(res.status, 200);
    const event = JSON.parse(queued);
    assert.equal(event.payload.link, 'https://reuters.com/world/story');
    assert.equal(
      formatMessage(event),
      '[HIGH] Community alert: Markets rally\n'
        + 'Source: Reuters\n'
        + 'https://reuters.com/world/story (source: reuters.com)',
    );
    // ...but it is still never a push click target for a caller event.
    assert.equal(formatEventLinkForPush(event), 'https://worldmonitor.app/');
  });

  it('redacts clickable URL tokens from caller title and description', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    let queued = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued = decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? '');
      return { ok: true };
    }) as typeof fetch;

    // The link field is locked down, so the lure moves into free text unless
    // the boundary redacts it there too.
    const res = await handler(makePost({
      eventType: 'rss_alert',
      payload: {
        title: 'Unusual sign-in. Verify at https://wm-verify-account.example/login',
        description: 'Confirm now: www.wm-verify-account.example/go',
      },
    }));
    assert.equal(res.status, 200);
    const event = JSON.parse(queued);
    const queuedText = JSON.stringify(event.payload);
    assert.ok(!queuedText.includes('wm-verify-account.example'), queuedText);
    assert.equal(
      event.payload.title,
      'Community alert: Unusual sign-in. Verify at [link removed]',
    );
    assert.equal(event.payload.description, 'Confirm now: [link removed]');
    assert.ok(!formatMessage(event).includes('wm-verify-account.example'));
  });

  it('normalises url-only targets and preserves the 400-character description budget', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    let queued = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued = decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? '');
      return { ok: true };
    }) as typeof fetch;

    const description = 'x'.repeat(350);
    const res = await handler(makePost({
      eventType: 'rss_alert',
      payload: { title: 'URL fallback', url: 'https://example.com/phish', description },
    }));

    assert.equal(res.status, 200);
    const event = JSON.parse(queued);
    // `url` is classified like `link`: kept when deliverable, and narrowed to
    // first-party only at the push sink.
    assert.equal(event.payload.url, 'https://example.com/phish');
    assert.equal(formatEventLinkForPush(event), 'https://worldmonitor.app/');
    assert.equal(event.payload.description, description);
  });

  it('falls back to the event type when a caller title sanitises to empty', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    let queued = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued = decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? '');
      return { ok: true };
    }) as typeof fetch;

    const res = await handler(makePost({
      eventType: 'market_alert',
      payload: { title: '\u200b\u0000' },
    }));

    assert.equal(res.status, 200);
    const event = JSON.parse(queued);
    assert.equal(event.payload.title, 'Community alert: market_alert');
  });
});

describe('formatMessage defence in depth (relay-originated events)', () => {
  it('neutralises a forged source while disclosing trusted relay article links', () => {
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

  it('discloses the host on a caller link in text, and never makes it a push target', () => {
    const event = {
      eventType: 'rss_alert',
      userId: TEST_USER_ID,
      payload: { title: 'Security notice', source: 'Reuters', link: 'https://example.com/phish' },
    };
    assert.equal(
      formatMessage(event),
      '[HIGH] Community alert: Security notice\n'
        + 'Source: Reuters\n'
        + 'https://example.com/phish (source: example.com)',
    );
    assert.equal(formatEventLinkForPush(event), 'https://worldmonitor.app/');
  });

  it('defeats confusable and nonspacing-mark source impersonation', () => {
    for (const source of [
      'World\u034fMonitor Security',
      'World\ufe0fMonitor Security',
      'Wоrldmonitor Security',
      'WorldМonitor Security',
      'Wοrldmonitor Security',
      'W0rldMonitor Security',
      'World+Monitor Security',
    ]) {
      const text = formatMessage({
        eventType: 'rss_alert',
        severity: 'critical',
        payload: { title: 'Security notice', source },
      });
      assert.ok(
        text.includes('Source: Community alert'),
        `must neutralise confusable impersonation ${JSON.stringify(source)}: ${text}`,
      );
    }
  });

  it('shapes the realtime webhook payload like every other sink', () => {
    const shaped = shapeEventForWebhook({
      eventType: 'rss_alert',
      severity: 'critical',
      payload: {
        title: 'Security notice',
        source: 'WorldMonitor Security',
        link: 'https://example.com/phish',
        countryCode: 'US',
      },
    });
    assert.equal(shaped.payload.source, 'Community alert');
    assert.equal(shaped.payload.link, 'https://example.com/phish');
    // Non-field keys pass through untouched so consumers keep their shape.
    assert.equal(shaped.payload.countryCode, 'US');
  });

  it('strips an attacker-steered URL out of the AI impact text before delivery', () => {
    assert.equal(
      sanitizeImpactText('Your account is locked, verify at https://evil.test/login'),
      'Your account is locked, verify at [link removed]',
    );
    assert.equal(sanitizeImpactText('This is WorldMonitor Security speaking'), '');
    assert.equal(sanitizeImpactText('Oil exposure rises for your portfolio.'),
      'Oil exposure rises for your portfolio.');
  });

  it('suppresses Discord link embeds so the host disclosure is not masked', () => {
    const payload = buildDiscordMessagePayload('see https://example.com/x (source: example.com)');
    assert.equal(payload.flags, 4, 'SUPPRESS_EMBEDS must be set');
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
  });

  it('legacy invisible and punctuation impersonation stays neutralised', () => {
    for (const source of [
      'World\u200bMonitor Security',
      'World\u2060Monitor Security',
      'World\u2066Monitor\u2069 Security',
      'ＷｏｒｌｄＭｏｎｉｔｏｒ Security',
      'World-Monitor Security',
      'World.Monitor Security',
    ]) {
      const text = formatMessage({
        eventType: 'rss_alert',
        severity: 'critical',
        payload: { title: 'Security notice', source },
      });
      assert.ok(!text.includes(source), `must not render lookalike source: ${text}`);
      assert.ok(text.includes('Community alert'), `lookalike source must collapse to the neutral label: ${text}`);
    }
  });

  it('shapes the title-less web-push fallback through the shared formatter', () => {
    assert.equal(
      formatEventTitle({ eventType: 'rss\nalert', payload: {} }, 'WorldMonitor'),
      'rss alert',
    );
    assert.equal(
      formatEventTitle({ eventType: 'rss\nalert', userId: TEST_USER_ID, payload: {} }, 'WorldMonitor'),
      'Community alert: rss alert',
    );
    assert.equal(
      formatEventTitle(
        { eventType: 'rss\nalert', userId: TEST_USER_ID, payload: { title: '\u200b\u0000' } },
        'WorldMonitor',
      ),
      'Community alert: rss alert',
    );
  });

  it('shapes the email subject with the same title boundary (no header injection)', () => {
    const hostile = formatSubject({
      eventType: 'rss_alert',
      userId: TEST_USER_ID,
      severity: 'critical',
      payload: { title: 'Security notice: verify your WorldMonitor account immediately' },
    });
    assert.equal(hostile, 'Community alert: Security notice: verify your WorldMonitor account immediately');
    assert.ok(!hostile.startsWith('WorldMonitor Alert:'), hostile);
    assert.ok(!hostile.includes('\r') && !hostile.includes('\n'), `subject must be single-line: ${hostile}`);
    const injected = formatSubject({
      eventType: 'rss_alert',
      payload: { title: 'Hi\r\nBcc: evil@x.com' },
    });
    assert.ok(!injected.includes('\r') && !injected.includes('\n'), `subject must strip newlines: ${injected}`);
    assert.ok(injected.includes('Hi Bcc:'), `newline collapses to space, content preserved: ${injected}`);
  });

  it('neutralises Slack and Discord channel markup at their sink boundaries', () => {
    assert.equal(
      escapeSlackText('<!channel> <https://evil.test|WorldMonitor> & more'),
      '&lt;!channel&gt; &lt;https://evil.test|WorldMonitor&gt; &amp; more',
    );
    assert.equal(
      escapeDiscordText('@everyone [WorldMonitor](https://evil.test)'),
      '@everyone \\[WorldMonitor](https://evil.test)',
    );
    assert.equal(
      escapeDiscordText('https://reuters.com/a_story_(update)'),
      'https://reuters.com/a_story_(update)',
    );
    assert.deepEqual(buildSlackMessagePayload('<!channel>'), {
      text: '&lt;!channel&gt;',
      unfurl_links: false,
    });
    assert.deepEqual(buildDiscordMessagePayload('@everyone [WorldMonitor](https://evil.test)'), {
      content: '@everyone \\[WorldMonitor](https://evil.test)',
      allowed_mentions: { parse: [] },
      flags: 4,
    });
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
