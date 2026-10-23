/**
 * The Business seat invite email links to a dashboard page that runs the
 * accept-business-invite hook in src/App.ts. The middleware returns a real
 * 404 for every path outside the public page allowlist (#6955), so the link
 * must target a known page, and links already sent to /settings must still
 * reach the dashboard with their query string intact. The same rule covers
 * every worldmonitor.app link in a Convex-sent email.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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

// Page paths linked from `src` that the middleware would 404. Same-file
// string constants are inlined first so `${APP_ORIGIN}${SOME_PATH}` is
// checked as the URL it builds. A name declared with different values in
// different scopes cannot be resolved without scope analysis, so it is
// reported instead of guessed.
function unservedPageLinks(src: string): string[] {
  const constants = new Map<string, Set<string>>();
  for (const m of src.matchAll(/const ([A-Z][A-Z0-9_]*)(?:: string)? = (["'`])([^"'`$]*)\2(?: as const)?;/g)) {
    if (!constants.has(m[1]!)) constants.set(m[1]!, new Set());
    constants.get(m[1]!)!.add(m[3]!);
  }
  const pages: string[] = [];
  const expanded = src.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (hole, name: string) => {
    const values = constants.get(name);
    if (!values) return hole;
    if (values.size > 1) {
      pages.push(`ambiguous constant ${name}`);
      return hole;
    }
    return [...values][0]!;
  });
  // Take the whole URL up to a delimiter or a template hole, then let URL
  // parsing decide the pathname.
  for (const m of expanded.matchAll(/https:\/\/(?:www\.)?worldmonitor\.app(?:(?!\$\{)[^\s"'<>`)\\])*/g)) {
    const page = new URL(m[0]).pathname.replace(/\/+$/, '') || '/';
    if (/\.[a-z0-9]{2,5}$/i.test(page) || page.startsWith('/api/')) continue;
    if (!isKnownPublicPagePath(page)) pages.push(page);
  }
  return pages;
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

  it('links every Convex email CTA to a page the middleware serves', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== '_generated') walk(path);
        } else if (entry.name.endsWith('.ts')) {
          for (const page of unservedPageLinks(readFileSync(path, 'utf8'))) {
            offenders.push(`${relative(root, path)}: ${page}`);
          }
        }
      }
    };
    walk(resolve(root, 'convex'));
    assert.deepEqual(offenders, [], 'these links open the not-found page');
  });

  it('flags bad links however the email source builds them', () => {
    const source = [
      'const APP_ORIGIN = "https://www.worldmonitor.app";',
      'const BILLING_PATH = "/billing" as const;',
      "const BRIEF_PATH = '/brief';",
      'const literal = "https://worldmonitor.app/brief";',
      'const tilde = "https://www.worldmonitor.app/dashboard~missing";',
      'const built = `${APP_ORIGIN}/settingz?x=${id}`;',
      'const joined = `${APP_ORIGIN}${BILLING_PATH}?t=${token}`;',
      'const single = `${APP_ORIGIN}${BRIEF_PATH}`;',
      'const fine = `${APP_ORIGIN}/dashboard`;',
      'const api = `${APP_ORIGIN}/api/customer-portal`;',
    ].join('\n');
    assert.deepEqual(unservedPageLinks(source), [
      '/brief',
      '/dashboard~missing',
      '/settingz',
      '/billing',
      '/brief',
    ]);
  });

  it('refuses to guess between same-named constants in different scopes', () => {
    const source = [
      'const APP_ORIGIN = "https://www.worldmonitor.app";',
      'function a() { const PAGE_PATH = "/brief"; return `${APP_ORIGIN}${PAGE_PATH}`; }',
      'function b() { const PAGE_PATH = "/dashboard" as const; return `${APP_ORIGIN}${PAGE_PATH}`; }',
    ].join('\n');
    assert.deepEqual(unservedPageLinks(source), [
      'ambiguous constant PAGE_PATH',
      'ambiguous constant PAGE_PATH',
    ]);
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
