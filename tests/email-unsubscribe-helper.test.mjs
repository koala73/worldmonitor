// One-click unsubscribe (RFC 8058) in the Railway mail workers. The workers
// never sign tokens: Convex /relay/channels hands each email channel
// pre-signed `unsubscribeUrls`. These tests pin the header/footer helpers and
// that the digest (brief) and relay (alerts) actually wire them in.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  SETTINGS_URL,
  UNSUBSCRIBE_SLOT,
  appendUnsubscribeText,
  injectUnsubscribeFooterHtml,
  listUnsubscribeHeaders,
  unsubscribeUrlFor,
} = require('../scripts/lib/email-unsubscribe.cjs');

const URL_OK = 'https://synthetic.convex.site/email/unsubscribe?t=v1.abc.def';

describe('scripts/lib/email-unsubscribe.cjs', () => {
  it('builds RFC 8058 headers only for https URLs', () => {
    assert.deepEqual(listUnsubscribeHeaders(URL_OK), {
      'List-Unsubscribe': `<${URL_OK}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    assert.equal(listUnsubscribeHeaders(null), undefined);
    assert.equal(listUnsubscribeHeaders('http://example.com/x'), undefined);
    assert.equal(listUnsubscribeHeaders('mailto:x@example.com'), undefined);
  });

  it('reads the per-list URL off a /relay/channels email channel', () => {
    const ch = { channelType: 'email', unsubscribeUrls: { brief: URL_OK, alerts: 'javascript:alert(1)' } };
    assert.equal(unsubscribeUrlFor(ch, 'brief'), URL_OK);
    assert.equal(unsubscribeUrlFor(ch, 'alerts'), null);
    assert.equal(unsubscribeUrlFor({ channelType: 'email' }, 'brief'), null);
    assert.equal(unsubscribeUrlFor(null, 'brief'), null);
  });

  it('fills the footer slot with an escaped unsubscribe link', () => {
    const html = `<div>body</div><p>${UNSUBSCRIBE_SLOT}</p>`;
    const out = injectUnsubscribeFooterHtml(html, `${URL_OK}&x="y"`, 'Unsubscribe from the daily brief');
    assert.ok(out.includes('Unsubscribe from the daily brief'));
    assert.ok(out.includes('&amp;x=&quot;y&quot;'));
    assert.ok(!out.includes(UNSUBSCRIBE_SLOT));
  });

  it('falls back to a visible Settings link and appends when no slot exists', () => {
    assert.equal(SETTINGS_URL, 'https://www.worldmonitor.app/dashboard?settings=notifications');
    const out = injectUnsubscribeFooterHtml('<div>body</div>', null, 'Unsubscribe');
    assert.ok(out.startsWith('<div>body</div>'));
    assert.ok(out.includes(SETTINGS_URL));
    assert.ok(out.includes('Manage email notifications'));
  });

  it('appends a plain-text unsubscribe line', () => {
    assert.equal(appendUnsubscribeText('Alert', URL_OK, 'Unsubscribe from alert emails'),
      `Alert\n\nUnsubscribe from alert emails: ${URL_OK}`);
    assert.equal(appendUnsubscribeText('Alert', null, 'x'), `Alert\n\nManage email notifications: ${SETTINGS_URL}`);
  });
});

describe('workers wire the unsubscribe URL into recurring mail', () => {
  it('digest email passes the brief URL and the template has the footer slot', () => {
    const src = readFileSync(join(root, 'scripts/seed-digest-notifications.mjs'), 'utf8');
    const template = readFileSync(join(root, 'scripts/lib/digest-email-html.mjs'), 'utf8');
    assert.match(src, /sendEmail\(ch\.email, subject, text, html, ch\)/);
    assert.match(src, /unsubscribeUrlFor\(channel, 'brief'\)/);
    assert.ok(template.includes(UNSUBSCRIBE_SLOT), 'formatDigestHtml footer must keep the unsubscribe slot');
    assert.match(src, /headers: listUnsubscribeHeaders\(unsubscribeUrl\)/);
  });

  it('relay alert emails (real-time and held batches) pass the alerts URL', () => {
    const src = readFileSync(join(root, 'scripts/notification-relay.cjs'), 'utf8');
    const calls = src.match(/sendEmail\(ch\.email, subject, (?:text|deliveryText), unsubscribeUrlFor\(ch, 'alerts'\)\)/g) ?? [];
    assert.equal(calls.length, 2);
    assert.match(src, /payload\.headers = listUnsubscribeHeaders\(unsubscribeUrl\)/);
  });
});
