/**
 * #10461: the dashboard footer is a thin meta line, so site destinations must
 * remain one tap away via Settings (desktop) and More (mobile). This suite pins
 * the Settings markup helper and the shared link list.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DASHBOARD_EXTERNAL_SITE_LINKS,
  DASHBOARD_REFERENCE_LINKS,
  DASHBOARD_SITE_ORIGIN,
  resolveDashboardSiteOrigin,
} from '../src/config/dashboard-reference-links.ts';
import { dashboardSiteLinksHtml } from '../src/utils/dashboard-site-links.ts';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('dashboard site links (#10461)', () => {
  it('exposes the crawlable reference set the footer used to host', () => {
    assert.deepEqual(
      DASHBOARD_REFERENCE_LINKS.map((link) => link.path),
      ['/countries/', '/chokepoints/', '/crises/', '/tools/', '/accuracy/'],
    );
  });

  it('renders every site destination into the Settings row', () => {
    const html = dashboardSiteLinksHtml(DASHBOARD_SITE_ORIGIN);
    for (const { path } of DASHBOARD_REFERENCE_LINKS) {
      assert.ok(html.includes(`href="${DASHBOARD_SITE_ORIGIN}${path}"`), `missing ${path}`);
    }
    assert.ok(html.includes(`href="${DASHBOARD_SITE_ORIGIN}/pro#pricing"`));
    for (const { href } of DASHBOARD_EXTERNAL_SITE_LINKS) {
      assert.ok(html.includes(`href="${href}"`), `missing ${href}`);
    }
    assert.match(html, /aria-label="World Monitor site"/);
    assert.match(html, /class="dashboard-site-links-row"/);
  });

  it('keeps reference destinations local for self-hosted and localhost dashboards', () => {
    assert.equal(resolveDashboardSiteOrigin({ isDesktopApp: false, hostname: 'localhost' }), '');
    assert.equal(resolveDashboardSiteOrigin({ isDesktopApp: false, hostname: 'dash.example.com' }), '');
    assert.equal(
      resolveDashboardSiteOrigin({ isDesktopApp: false, hostname: 'www.worldmonitor.app' }),
      DASHBOARD_SITE_ORIGIN,
    );
    assert.equal(
      resolveDashboardSiteOrigin({ isDesktopApp: true, hostname: 'localhost' }),
      DASHBOARD_SITE_ORIGIN,
    );
    const html = dashboardSiteLinksHtml('');
    for (const { path } of DASHBOARD_REFERENCE_LINKS) {
      assert.ok(html.includes(`href="${path}"`), `self-host missing relative ${path}`);
      assert.ok(!html.includes(`href="${DASHBOARD_SITE_ORIGIN}${path}"`), `self-host must not force www for ${path}`);
    }
    assert.ok(html.includes('href="/pro#pricing"'));
  });

  it('Settings lists the site links above the legal links on the About page', () => {
    const source = read('src/components/UnifiedSettings.ts');
    const about = source.slice(source.indexOf('    about: (body) => {'));
    assert.match(about, /dashboardSiteLinksHtml\(resolveDashboardSiteOrigin\(/);
    const siteIdx = about.indexOf('dashboardSiteLinksHtml(');
    const legalIdx = about.indexOf('legalLinksHtml(');
    assert.ok(siteIdx >= 0 && legalIdx > siteIdx, 'site links must render above legal links');
    // About replaces the footer that used to pin both rows under every tab.
    assert.doesNotMatch(source, /dashboard-chrome-links/);
    assert.doesNotMatch(read('src/styles/main.css'), /dashboard-chrome-links/);
  });

  it('compact dashboard footer CSS caps height at 28px', () => {
    const css = read('src/styles/main.css');
    const block = css.match(/\.site-footer\s*\{([^}]*)\}/);
    assert.ok(block, '.site-footer rule must exist');
    assert.match(block[1], /max-height:\s*28px/);
    assert.match(block[1], /overflow:\s*hidden/);
  });
});
