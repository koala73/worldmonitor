/**
 * Sentry keeps user identity and page state, but never the credentials the
 * shared sensitive-param list keeps away from every other telemetry vendor.
 *
 * Run: node --import tsx --test tests/sentry-credential-scrub.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scrubSentryCredentials } from '../shared/sensitive-url-params.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const INVITE = 'https://www.worldmonitor.app/settings?accept-business-invite=g1&token=SECRET_TOKEN&tab=team';

describe('scrubSentryCredentials', () => {
  it('drops credential params from event URLs and keeps identity and benign params', () => {
    const event = {
      user: { id: 'user_abc', ip_address: '{{auto}}' },
      request: {
        url: INVITE,
        headers: { Referer: 'https://www.worldmonitor.app/?__clerk_ticket=TICKET&view=map', 'User-Agent': 'UA' },
        query_string: 'license_key=LK&q=iran',
      },
      breadcrumbs: [
        { category: 'navigation', data: { from: '/', to: '/settings?token=SECRET_TOKEN&tab=team' } },
        { category: 'fetch', data: { url: '/api/x?access_token=AT&limit=5', method: 'GET' } },
        { category: 'console', message: `loaded ${INVITE} ok` },
      ],
      exception: { values: [{ value: 'Failed for /pro?email=a@b.com&plan=pro' }] },
    };

    const out = scrubSentryCredentials(event);
    assert.equal(out, event, 'scrubs in place so beforeSend keeps event identity');
    const json = JSON.stringify(out);
    for (const secret of ['SECRET_TOKEN', 'TICKET', 'LK', 'AT&', 'a@b.com', 'g1']) {
      assert.ok(!json.includes(secret), `${secret} must not reach Sentry: ${json}`);
    }
    assert.deepEqual(out.user, { id: 'user_abc', ip_address: '{{auto}}' });
    assert.equal(new URL(out.request.url).searchParams.get('tab'), 'team');
    assert.equal(out.request.query_string, 'q=iran');
    assert.equal(out.request.headers['User-Agent'], 'UA');
    assert.equal(out.breadcrumbs[0]!.data!.to, '/settings?tab=team');
    assert.equal(out.breadcrumbs[1]!.data!.url, '/api/x?limit=5');
    assert.match(out.exception.values[0]!.value, /plan=pro/);
  });

  it('removes credential-named fields at any depth', () => {
    const event = {
      contexts: { auth: { accessToken: 'A', refreshToken: 'R', client_secret: 'C', scope: 'read' } },
      request: { headers: { Authorization: 'Bearer X', Cookie: 'c=1', 'X-Api-Key': 'K', Accept: '*/*' } },
      extra: { password: 'p', token: 't', count: 3 },
    };
    const out = scrubSentryCredentials(event);
    assert.deepEqual(out.contexts.auth, { scope: 'read' });
    assert.deepEqual(out.request.headers, { Accept: '*/*' });
    assert.deepEqual(out.extra, { count: 3 });
  });

  it('scrubs span query and fragment attributes', () => {
    const span = { data: { 'url.full': INVITE, 'http.query': '?token=T1&page=2', 'http.fragment': '#access_token=T2&x=1' } };
    const out = scrubSentryCredentials(span);
    assert.ok(!JSON.stringify(out).includes('T1') && !JSON.stringify(out).includes('T2'));
    assert.equal(out.data['http.query'], '?page=2');
    assert.equal(out.data['http.fragment'], '#x=1');
  });

  it('survives cycles and non-URL strings', () => {
    const event: Record<string, unknown> = { message: 'plain text', n: 1 };
    event.self = event;
    assert.equal(scrubSentryCredentials(event), event);
    assert.equal(event.message, 'plain text');
  });
});

describe('Sentry init wiring', () => {
  for (const file of ['src/bootstrap/sentry-init.ts', 'pro-test/src/sentry.ts']) {
    it(`${file} scrubs events, breadcrumbs, transactions and spans`, () => {
      const src = read(file);
      for (const hook of ['beforeBreadcrumb', 'beforeSendTransaction', 'beforeSendSpan']) {
        assert.match(src, new RegExp(`${hook}: scrubSentryCredentials`), `${hook} must scrub`);
      }
      assert.match(src, /return scrubSentryCredentials\(/, 'beforeSend must return a scrubbed event');
    });
  }
});
