/**
 * The Business seat invite email links to a dashboard page that runs the
 * accept-business-invite hook in src/App.ts. The middleware returns a real
 * 404 for every path outside the public page allowlist (#6955), so the link
 * must target a known page, and links already sent to /settings must still
 * reach the dashboard with their query string intact.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import middleware from '../middleware.ts';
import { isKnownPublicPagePath } from '../src/config/agent-not-found.ts';

const root = resolve(import.meta.dirname, '..');
const seatsSource = readFileSync(resolve(root, 'convex/payments/businessSeats.ts'), 'utf8');
const vercelConfig = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')) as {
  redirects: Array<{ source: string; destination: string; permanent?: boolean; has?: unknown }>;
};

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function browserGet(pathAndQuery: string): Response | void {
  return middleware(
    new Request(`https://www.worldmonitor.app${pathAndQuery}`, {
      headers: { host: 'www.worldmonitor.app', 'user-agent': CHROME_UA, accept: 'text/html' },
    }),
  ) as Response | void;
}

function inviteUrlFromEmail(): URL {
  const match = seatsSource.match(/const acceptUrl = `([^`]+)`/);
  assert.ok(match, 'sendBusinessInviteEmail must build acceptUrl from a template literal');
  return new URL(match[1].replace(/\$\{[^}]+\}/g, 'x'));
}

describe('Business seat invite link', () => {
  it('points the emailed accept link at a page the middleware serves', () => {
    const url = inviteUrlFromEmail();
    assert.equal(url.host, 'www.worldmonitor.app');
    assert.ok(isKnownPublicPagePath(url.pathname), `${url.pathname} would 404`);
    assert.equal(browserGet(`${url.pathname}${url.search}`)?.status === 404, false);
    assert.equal(url.searchParams.has('accept-business-invite'), true);
    assert.equal(url.searchParams.has('token'), true);
  });

  it('keeps already-sent /settings invite links working', () => {
    assert.ok(isKnownPublicPagePath('/settings'), '/settings must pass the 404 gate');
    assert.equal(browserGet('/settings?accept-business-invite=g1&token=t1')?.status === 404, false);
    const redirect = vercelConfig.redirects.find((rule) => rule.source === '/settings');
    assert.ok(redirect, 'vercel.json must redirect /settings');
    assert.equal(redirect.destination, '/dashboard');
    assert.equal(redirect.permanent, false);
    assert.equal(redirect.has, undefined);
  });
});
