// Relay emails (real-time alert, quiet-hours batch, connected welcome) used to
// go out as bare text next to the designed daily brief. They now share the
// digest's frame (scripts/lib/notification-email-html.cjs), with the text kept
// as the plain-text part.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const html = require('../scripts/lib/notification-email-html.cjs');
const { injectUnsubscribeFooterHtml, UNSUBSCRIBE_SLOT } = require('../scripts/lib/email-unsubscribe.cjs');

const ALERT = {
  title: 'Extreme wind warning: Alakol district, Kazakhstan',
  severity: 'critical',
  countryCode: 'KZ',
  source: 'WMO SWIC',
  coverage: '3 independent publishers',
  description: 'Gusts above 30 m/s expected.',
  link: 'https://reuters.com/world/asia/x',
  eventType: 'weather_alert',
};

describe('real-time alert email', () => {
  const out = html.buildAlertEmailHtml(ALERT);

  it('uses the digest frame: logo, accent bar, footer slot', () => {
    assert.match(out, /android-chrome-192x192\.png/);
    assert.match(out, /WORLD MONITOR/);
    assert.match(out, /background: #4ade80; height: 3px/);
    assert.ok(out.includes(UNSUBSCRIBE_SLOT));
  });

  it('lays out the shaped fields, with the country named and the severity coloured', () => {
    assert.match(out, /Extreme wind warning: Alakol district, Kazakhstan/);
    assert.match(out, /Kazakhstan \(KZ\)/);
    assert.match(out, /WMO SWIC/);
    assert.match(out, /3 independent publishers/);
    assert.match(out, /weather alert/);
    assert.match(out, /border-left: 3px solid #ef4444/);
  });

  it('names the host of an off-origin link and keeps a dashboard button', () => {
    assert.match(out, /href="https:\/\/reuters\.com\/world\/asia\/x"/);
    assert.match(out, /The report opens on reuters\.com\./);
    assert.match(out, /Open dashboard/);
  });

  it('escapes every field, so a hostile title or source renders as text', () => {
    const hostile = html.buildAlertEmailHtml({
      ...ALERT,
      title: '<img src=x onerror=alert(1)>"quoted"',
      source: '<a href="https://evil.test">verify</a>',
      impact: '<script>x</script>',
    });
    assert.ok(!hostile.includes('<img src=x'));
    assert.ok(!hostile.includes('<script>x'));
    assert.ok(!hostile.includes('<a href="https://evil.test"'));
    assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;&quot;quoted&quot;/);
  });

  it('sends a non-https or unparseable link to the dashboard instead', () => {
    for (const link of ['javascript:alert(1)', 'http://plain.example/x']) {
      const out2 = html.buildAlertEmailHtml({ ...ALERT, link });
      assert.ok(!out2.includes(link), link);
      assert.match(out2, /href="https:\/\/worldmonitor\.app\/"/);
    }
  });

  it('renders the AI impact block only when there is one', () => {
    assert.doesNotMatch(out, />Impact</);
    assert.match(html.buildAlertEmailHtml({ ...ALERT, impact: 'Flights at ALA likely delayed.' }), />Impact<[\s\S]*Flights at ALA likely delayed\./);
  });

  it('stays email-client safe: inline styles only, no <style> block or flex layout', () => {
    assert.doesNotMatch(out, /<style/i);
    assert.doesNotMatch(out, /display:\s*flex/);
  });
});

describe('quiet-hours batch email', () => {
  const out = html.buildHeldAlertsEmailHtml([
    { title: 'Held story one', severity: 'high', coverage: 'Coverage: single publisher', link: 'https://apnews.com/a' },
    { title: 'Held story two', severity: 'critical' },
  ]);

  it('counts the alerts and renders one card each, coloured by severity', () => {
    assert.match(out, /2 alerts held during quiet hours/);
    assert.match(out, /Held story one/);
    assert.match(out, /Held story two/);
    assert.match(out, /border-left: 3px solid #f97316/);
    assert.match(out, /border-left: 3px solid #ef4444/);
    assert.match(out, /apnews\.com/);
  });

  it('uses the singular for one alert', () => {
    assert.match(html.buildHeldAlertsEmailHtml([{ title: 'Only', severity: 'high' }]), /1 alert held during quiet hours/);
  });
});

describe('welcome email', () => {
  it('links to the notification settings', () => {
    const out = html.buildWelcomeEmailHtml();
    assert.match(out, /Email notifications are on/);
    assert.match(out, /settings=notifications/);
  });
});

describe('unsubscribe footer', () => {
  it('fills the footer slot with the one-click link', () => {
    const out = injectUnsubscribeFooterHtml(html.buildAlertEmailHtml(ALERT), 'https://x.convex.site/email/unsubscribe?t=abc', 'Unsubscribe from alert emails');
    assert.ok(!out.includes(UNSUBSCRIBE_SLOT));
    assert.match(out, /href="https:\/\/x\.convex\.site\/email\/unsubscribe\?t=abc"[^>]*>Unsubscribe from alert emails</);
  });
});

// The relay hands the designed body to Resend alongside the text part.
describe('notification relay email delivery', () => {
  const sent = [];
  let relay;
  let originalFetch;
  const originalLoad = Module._load;

  before(() => {
    process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
    process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
    process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
    process.env.TELEGRAM_BOT_TOKEN ??= 'stub-bot-token';
    process.env.RESEND_API_KEY = 'stub-resend';
    Module._load = function patchedLoad(request, parent, ...rest) {
      if (request === 'resend') {
        return { Resend: class { constructor() { this.emails = { send: async (payload) => { sent.push(payload); return { data: { id: 'm1' }, error: null }; } }; } } };
      }
      if (request === 'convex/browser') return { ConvexHttpClient: class { async query() {} } };
      return originalLoad.call(this, request, parent, ...rest);
    };
    relay = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/relay/enabled-rules')) {
        return Response.json([{ userId: 'user-1', digestMode: 'realtime', eventTypes: [], sensitivity: 'critical', countries: ['KZ'], channels: ['email'], variant: 'full' }]);
      }
      if (path.includes('/relay/entitlement')) return Response.json({ tier: 1 });
      if (path.includes('/relay/channels')) {
        return Response.json([{
          channelType: 'email', verified: true, emailOwnership: 'verified_account', email: 'owner@example.com',
          unsubscribeUrls: { alerts: 'https://x.convex.site/email/unsubscribe?t=abc' },
        }]);
      }
      // Upstash: SET NX succeeds (no dedup hit), every read misses.
      return Response.json({ result: path.startsWith('/SET/') ? 'OK' : null });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    Module._load = originalLoad;
  });

  it('sends the alert with an HTML body, the text part, and the unsubscribe link in both', async () => {
    await relay.processEvent({
      eventType: 'weather_alert',
      severity: 'critical',
      payload: { title: 'Extreme wind warning: Alakol district, Kazakhstan', countryCode: 'KZ', source: 'WMO SWIC' },
    });
    assert.equal(sent.length, 1);
    const [email] = sent;
    assert.match(email.text, /Extreme wind warning/);
    assert.match(email.text, /Unsubscribe from alert emails: https:\/\/x\.convex\.site/);
    assert.match(email.html, /WORLD MONITOR/);
    assert.match(email.html, /Kazakhstan \(KZ\)/);
    assert.match(email.html, />Unsubscribe from alert emails</);
    assert.ok(!email.html.includes(UNSUBSCRIBE_SLOT));
  });
});
