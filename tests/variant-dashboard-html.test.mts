import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_DASHBOARD_VARIANTS,
  renderVariantDashboardHtml,
  variantDashboardFileName,
} from '../src/config/variant-dashboard-html';
import { VARIANT_META } from '../src/config/variant-meta';

// Mirrors the exact markup shapes of the BUILT dist/dashboard.html (index.html
// after htmlVariantPlugin with the full meta): trailing ` />` on metas,
// pretty-printed JSON-LD with the WebApplication block first, hreflang cluster
// with ?lang= suffixes, and the visually-hidden app-heading <h1>. If the real
// markup drifts, renderVariantDashboardHtml throws at build time — this
// fixture only exercises the transform logic.
const FULL = VARIANT_META.full;
const fixture = `<!doctype html>
<html lang="en">
  <head>
    <title>${FULL.title}</title>
    <meta name="title" content="${FULL.title}" />
    <meta name="description" content="${FULL.description}" />
    <meta name="keywords" content="${FULL.keywords}" />
    <link rel="canonical" href="${FULL.url}" />
    <link rel="alternate" hreflang="x-default" href="${FULL.url}" />
    <link rel="alternate" hreflang="fr" href="${FULL.url}?lang=fr" />
    <meta name="application-name" content="World Monitor" />
    <meta name="subject" content="${FULL.subject}" />
    <meta name="classification" content="${FULL.classification}" />
    <meta property="og:url" content="${FULL.url}" />
    <meta property="og:title" content="${FULL.title}" />
    <meta property="og:description" content="${FULL.description}" />
    <meta property="og:image" content="https://www.worldmonitor.app/favico/og-image.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:site_name" content="World Monitor" />
    <meta name="twitter:url" content="${FULL.url}" />
    <meta name="twitter:title" content="${FULL.title}" />
    <meta name="twitter:description" content="${FULL.description}" />
    <meta name="twitter:image" content="https://www.worldmonitor.app/favico/og-image.png" />
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      "name": "World Monitor",
      "alternateName": ["WorldMonitor", "World Monitor App", "WM Intelligence"],
      "url": "${FULL.url}",
      "screenshot": "https://www.worldmonitor.app/favico/og-image.png",
      "featureList": [
        "Real-time news aggregation",
        "Stock market tracking"
      ]
    }
    </script>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": "World Monitor",
      "alternateName": "WorldMonitor",
      "url": "https://www.worldmonitor.app/"
    }
    </script>
  </head>
  <body>
    <h1 class="app-heading">World Monitor — Real-Time Global Intelligence Dashboard</h1>
    <p>Link to <a href="${FULL.url}">the main dashboard</a> stays untouched.</p>
  </body>
</html>`;

const escHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

describe('renderVariantDashboardHtml (#4996)', () => {
  it('self-canonicalizes each variant on its own subdomain', () => {
    for (const variant of WEB_DASHBOARD_VARIANTS) {
      const html = renderVariantDashboardHtml(fixture, variant);
      const meta = VARIANT_META[variant];
      assert.ok(
        html.includes(`<link rel="canonical" href="${meta.url}" />`),
        `${variant}: canonical should be ${meta.url}`,
      );
      assert.ok(html.includes(`<meta property="og:url" content="${meta.url}" />`), `${variant}: og:url`);
      assert.ok(html.includes(`<meta name="twitter:url" content="${meta.url}" />`), `${variant}: twitter:url`);
      assert.ok(
        !html.includes(`<link rel="canonical" href="${FULL.url}" />`),
        `${variant}: must not keep the www canonical`,
      );
    }
  });

  it('rewrites brand meta, hreflang cluster, social images, and h1 for tech', () => {
    const html = renderVariantDashboardHtml(fixture, 'tech');
    const tech = VARIANT_META.tech;
    assert.ok(html.includes(`<title>${escHtml(tech.title)}</title>`), 'title');
    assert.ok(html.includes(`<meta name="description" content="${escHtml(tech.description)}" />`), 'description');
    assert.ok(html.includes(`<meta property="og:site_name" content="Tech Monitor" />`), 'og:site_name');
    assert.ok(html.includes(`<meta name="application-name" content="Tech Monitor" />`), 'application-name');
    assert.ok(html.includes(`<meta name="subject" content="${escHtml(tech.subject)}" />`), 'subject');
    assert.ok(
      html.includes(`<link rel="alternate" hreflang="fr" href="${tech.url}?lang=fr" />`),
      'hreflang keeps ?lang suffix on the variant host',
    );
    assert.ok(
      html.includes(`<link rel="alternate" hreflang="x-default" href="${tech.url}" />`),
      'x-default alternate moves to the variant host',
    );
    assert.ok(
      html.includes('content="https://tech.worldmonitor.app/favico/tech/og-image.png"'),
      'og/twitter image points at the variant OG asset',
    );
    assert.ok(html.includes('<meta property="og:image:width" content="1200" />'), 'og:image:width untouched');
    assert.ok(html.includes(`<h1 class="app-heading">${escHtml(tech.title)}</h1>`), 'h1');
  });

  it('rewrites the WebApplication JSON-LD block but leaves the Organization block as World Monitor', () => {
    const html = renderVariantDashboardHtml(fixture, 'finance');
    const finance = VARIANT_META.finance;
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)].map(
      (m) => JSON.parse(m[1]),
    );
    assert.equal(blocks.length, 2, 'both JSON-LD blocks stay parseable');
    const webApp = blocks.find((b) => b['@type'] === 'WebApplication');
    const org = blocks.find((b) => b['@type'] === 'Organization');
    assert.equal(webApp.name, 'Finance Monitor');
    assert.equal(webApp.url, finance.url);
    assert.equal(webApp.screenshot, 'https://finance.worldmonitor.app/favico/finance/og-image.png');
    assert.deepEqual(webApp.featureList, finance.features);
    assert.equal(org.name, 'World Monitor', 'variant isPartOf World Monitor — org identity stays');
    assert.equal(org.url, 'https://www.worldmonitor.app/');
  });

  it('leaves body links to the main dashboard untouched', () => {
    const html = renderVariantDashboardHtml(fixture, 'energy');
    assert.ok(html.includes(`<a href="${FULL.url}">the main dashboard</a>`));
  });

  it('throws loudly when an anchor is missing (markup drift guard)', () => {
    const withoutCanonical = fixture.replace(/<link rel="canonical"[^>]*>\n/, '');
    assert.throws(() => renderVariantDashboardHtml(withoutCanonical, 'tech'), /anchor "canonical" matched 0/);
  });

  it('throws loudly when an anchor is duplicated', () => {
    const doubled = fixture.replace(
      `<link rel="canonical" href="${FULL.url}" />`,
      `<link rel="canonical" href="${FULL.url}" />\n    <link rel="canonical" href="${FULL.url}" />`,
    );
    assert.throws(() => renderVariantDashboardHtml(doubled, 'tech'), /anchor "canonical" matched 2/);
  });

  it('rejects unknown variants and the full variant itself', () => {
    assert.throws(() => renderVariantDashboardHtml(fixture, 'full'));
    assert.throws(() => renderVariantDashboardHtml(fixture, 'nope'));
  });

  it('names output files after the variant', () => {
    assert.equal(variantDashboardFileName('tech'), 'dashboard-tech.html');
  });
});
