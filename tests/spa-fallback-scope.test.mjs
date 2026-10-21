// #6575 — unknown paths must return a real 404, not the dashboard SPA.
// Diligence and security tooling reads a 200 + dashboard document as "the
// page exists". The negative-lookahead catch-all rewrite is gone; the SPA
// document is served only by the enumerated client-side History routes.
//
// #6640 coordination: /security (and /trust) intentionally have NO rule here.
// When the trust page ships it adds its own file/rewrite without having to
// undo a hardcoded exclusion — until then both 404 like any unknown path.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

const DASHBOARD_HTML_DESTINATION = '/dashboard.html';

// The vercel.json `source` subset used by dashboard-serving rules.
function sourceToRegExp(source) {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === ':') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      if (source[j] === '*') {
        out = out.replace(/\/$/, '');
        out += '(?:/.*)?';
        i = j;
      } else {
        out += '[^/]+';
        i = j - 1;
      }
    } else {
      out += /[.*+?^${}|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`^${out}$`);
}

const dashboardRewrites = () => vercel.rewrites.filter((r) => r.destination === DASHBOARD_HTML_DESTINATION);
const dashboardShadow = (path) => dashboardRewrites().find((r) => sourceToRegExp(r.source).test(path));

describe('SPA fallback scope (#6575)', () => {
  it('serves the dashboard document only from the enumerated client History routes', () => {
    assert.deepEqual(
      dashboardRewrites().map((r) => r.source).sort(),
      ['/dashboard', '/stocks', '/stocks/:symbol', '/story'],
      'inventory: /dashboard itself plus the client History routes',
    );
    const story = vercel.rewrites.find((r) => r.source === '/story');
    assert.equal(story?.destination, DASHBOARD_HTML_DESTINATION);
  });

  it('unknown paths match no rewrite and fall through to a filesystem 404', () => {
    for (const path of ['/this-is-not-a-page', '/security', '/trust', '/wp-admin/setup-config.php']) {
      assert.equal(dashboardShadow(path), undefined, `${path} must not serve the dashboard`);
      const any = vercel.rewrites.find((r) => sourceToRegExp(r.source).test(path));
      assert.equal(any, undefined, `${path} must not match any rewrite at all`);
    }
  });

  it('real client-side deep links keep reaching the SPA document', () => {
    assert.equal(dashboardShadow('/dashboard')?.destination, DASHBOARD_HTML_DESTINATION);
    assert.equal(dashboardShadow('/stocks')?.destination, DASHBOARD_HTML_DESTINATION);
    assert.equal(dashboardShadow('/stocks/AAPL')?.destination, DASHBOARD_HTML_DESTINATION);
    assert.equal(dashboardShadow('/story')?.destination, DASHBOARD_HTML_DESTINATION);
    assert.equal(dashboardShadow('/stocks/foo/bar'), undefined, 'nested /stocks paths must 404, not soft-404 the SPA');
  });

  it('canonicalizes trailing-slash History URLs instead of 404ing them', () => {
    const dest = (source) => vercel.redirects.find((r) => r.source === source)?.destination;
    assert.equal(dest('/dashboard/'), '/dashboard');
    assert.equal(dest('/story/'), '/story');
    assert.equal(dest('/stocks/'), '/stocks');
    assert.equal(dest('/stocks/:symbol/'), '/stocks/:symbol');
  });

  it('never reintroduces a negative-lookahead SPA catch-all', () => {
    const catchAll = vercel.rewrites.find((r) =>
      r.destination === DASHBOARD_HTML_DESTINATION && r.source.includes('(?!')
    );
    assert.equal(catchAll, undefined, 'the exclusion-list catch-all is the soft-404 root cause (#6575)');
  });
});
