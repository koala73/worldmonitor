import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { AGENT_NOT_FOUND_PASSTHROUGH_PREFIXES } from '../src/config/agent-not-found.ts';
import {
  INDEXABLE_LANDING_LOCALES,
  defaultLandingLocale,
  indexableLandingPassthroughPrefixes,
  landingByPath,
  landingHreflangCluster,
  nonDefaultLandingLocales,
} from '../shared/indexable-landing-locales.ts';
import { localizeWelcomeDocument } from '../pro-test/src/welcome-document.ts';

const vercelConfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  redirects: Array<{ source: string; destination: string; has?: unknown[] }>;
  headers: Array<{ source: string }>;
};

describe('indexable landing locale registry', () => {
  it('pins English as x-default and keeps path ids aligned with app locale codes', () => {
    const english = defaultLandingLocale();
    assert.equal(english.id, 'en');
    assert.equal(english.canonicalPath, '/');
    assert.equal(english.canonicalUrl, 'https://www.worldmonitor.app/');
    assert.deepEqual(
      nonDefaultLandingLocales().map((locale) => locale.id),
      ['es', 'pt', 'ru', 'fr', 'de', 'ar'],
    );
    const portuguese = INDEXABLE_LANDING_LOCALES.find((locale) => locale.id === 'pt');
    assert.equal(portuguese?.canonicalPath, '/pt/');
    assert.equal(portuguese?.hreflang, 'pt-BR');
    assert.equal(portuguese?.ogLocale, 'pt_BR');
    assert.equal(INDEXABLE_LANDING_LOCALES.find((locale) => locale.id === 'ar')?.dir, 'rtl');
  });

  it('matches only the landing path itself', () => {
    assert.equal(landingByPath('/')?.id, 'en');
    assert.equal(landingByPath('/es')?.id, 'es');
    assert.equal(landingByPath('/es/')?.id, 'es');
    assert.equal(landingByPath('/pt-br/'), undefined);
    assert.equal(landingByPath('/es/dashboard'), undefined);
    assert.equal(landingByPath('/zh'), undefined);
  });

  it('publishes a reciprocal cluster without query-string targets', () => {
    const cluster = landingHreflangCluster();
    assert.equal(cluster[0]?.hreflang, 'x-default');
    assert.equal(cluster[0]?.href, 'https://www.worldmonitor.app/');
    const codes = cluster.map((entry) => entry.hreflang);
    assert.deepEqual(codes, ['x-default', 'en', 'es', 'pt-BR', 'ru', 'fr', 'de', 'ar']);
    assert.equal(new Set(codes).size, codes.length);
    for (const entry of cluster) {
      assert.equal(new URL(entry.href).search, '');
      assert.doesNotMatch(entry.href, /[?&]lang=/i);
    }
    assert.deepEqual(
      indexableLandingPassthroughPrefixes(),
      ['/es', '/pt', '/ru', '/fr', '/de', '/ar'],
    );
  });

  it('keeps slash redirects, variant-host redirects, and 404 passthroughs on the registry', () => {
    for (const locale of nonDefaultLandingLocales()) {
      const slash = vercelConfig.redirects.find((rule) => rule.source === `/${locale.pathSegment}` && !rule.has);
      assert.ok(slash, `/${locale.pathSegment} must 308 onto the trailing-slash landing`);
      assert.equal(slash.destination, locale.canonicalPath);
      const host = vercelConfig.redirects.find((rule) => rule.source === `/${locale.pathSegment}/:match(.*)`);
      assert.ok(host, `variant hosts must send /${locale.pathSegment}/ to www`);
      assert.equal(host.destination, `https://www.worldmonitor.app/${locale.pathSegment}/:match`);
      assert.ok(
        (AGENT_NOT_FOUND_PASSTHROUGH_PREFIXES as readonly string[]).includes(`/${locale.pathSegment}`),
        `/${locale.pathSegment} must not 404 the prerendered landing`,
      );
    }
    const landingIds = nonDefaultLandingLocales().map((locale) => locale.pathSegment).join('|');
    assert.ok(
      vercelConfig.headers.some((rule) => rule.source === `/(${landingIds})/`),
      'canonical locale landings must have an exact-path header source derived from the registry',
    );
  });

  it('rewrites a cloned English document into a self-canonical localized landing', () => {
    const spanish = INDEXABLE_LANDING_LOCALES.find((locale) => locale.id === 'es');
    assert.ok(spanish);
    const html = localizeWelcomeDocument(
      `<!doctype html><html lang="en"><head>
        <title>English title</title>
        <meta name="description" content="English description" />
        <link rel="canonical" href="https://www.worldmonitor.app/" />
        <link rel="alternate" hreflang="x-default" href="https://www.worldmonitor.app/" />
        <link rel="alternate" hreflang="en" href="https://www.worldmonitor.app/" />
        <meta property="og:title" content="English og" />
        <meta property="og:description" content="English og description" />
        <meta property="og:url" content="https://www.worldmonitor.app/" />
        <meta property="og:locale" content="en_US" />
        <meta name="twitter:title" content="English og" />
        <meta name="twitter:description" content="English twitter" />
        <script type="application/ld+json">{"@type":"WebSite","@id":"https://www.worldmonitor.app/#website","inLanguage":"en"}</script>
        <script type="application/ld+json">{"@type":"WebPage","@id":"https://www.worldmonitor.app/#webpage","url":"https://www.worldmonitor.app/","name":"English og","description":"English description"}</script>
        <script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"English q","acceptedAnswer":{"@type":"Answer","text":"English a"}}]}</script>
        </head><body><div id="root"></div></body></html>`,
      spanish,
      {
        title: 'Titulo ES',
        description: 'Descripcion ES',
        ogTitle: 'OG ES',
        ogDescription: 'OG desc ES',
        faqs: [{ q: 'Pregunta', a: 'Respuesta' }],
      },
    );
    assert.match(html, /<html lang="es"/);
    assert.match(html, /<title>Titulo ES<\/title>/);
    assert.match(html, /rel="canonical" href="https:\/\/www.worldmonitor.app\/es\/"/);
    assert.match(html, /hreflang="es" href="https:\/\/www.worldmonitor.app\/es\/"/);
    assert.match(html, /hreflang="x-default" href="https:\/\/www.worldmonitor.app\/"/);
    assert.match(html, /og:locale" content="es_ES"/);
    assert.match(html, /data-wm-prerender-lang="es"/);
    assert.match(html, /"@id":"https:\/\/www.worldmonitor.app\/es\/#webpage"/);
    assert.match(html, /"inLanguage":"en"/);
    assert.match(html, /"name":"Pregunta"/);
  });

  it('drops the English noscript fallback from locale clones and keeps $-sequences literal', () => {
    const spanish = INDEXABLE_LANDING_LOCALES.find((locale) => locale.id === 'es');
    assert.ok(spanish);
    const html = localizeWelcomeDocument(
      `<!doctype html><html lang="en"><head>
        <title>English title</title>
        <meta name="description" content="English description" />
        <meta property="og:title" content="English og" />
        <noscript><link rel="stylesheet" href="/pro/assets/index.css"></noscript>
        </head><body>
        <noscript><div><h2>World Monitor — English fallback</h2><p>English copy</p></div></noscript>
        <div id="root"></div></body></html>`,
      spanish,
      {
        title: "Precio $' y $& final",
        description: 'Cuesta $1 y $2',
        ogTitle: 'OG $$ ES',
        ogDescription: 'OG desc ES',
        faqs: [],
      },
    );
    assert.doesNotMatch(html, /English fallback/, 'locale clones must not ship the English noscript body');
    assert.match(html, /<noscript><link rel="stylesheet"/, 'the head stylesheet fallback stays');
    assert.match(html, /<title>Precio \$' y \$&amp; final<\/title>/);
    assert.match(html, /<meta name="description" content="Cuesta \$1 y \$2" \/>/);
    assert.match(html, /<meta property="og:title" content="OG \$\$ ES" \/>/);
  });

  it('installs only the canonical and hreflang cluster on the English default document', () => {
    const english = defaultLandingLocale();
    const html = localizeWelcomeDocument(
      `<!doctype html><html lang="en"><head>
        <title>Template title</title>
        <meta name="description" content="Template description" />
        <link rel="canonical" href="https://www.worldmonitor.app/" />
        <link rel="alternate" hreflang="x-default" href="https://www.worldmonitor.app/" />
        <link rel="alternate" hreflang="en" href="https://www.worldmonitor.app/" />
        <meta property="og:description" content="Template og description" />
        <meta name="twitter:description" content="Template twitter description" />
        </head><body>
        <noscript><div><h2>English fallback</h2></div></noscript>
        <div id="root"></div></body></html>`,
      english,
      {
        title: 'i18n title',
        description: 'i18n description',
        ogTitle: 'i18n og title',
        ogDescription: 'i18n og description',
        faqs: [],
      },
    );
    assert.match(html, /<title>Template title<\/title>/);
    assert.match(html, /<meta name="description" content="Template description" \/>/);
    assert.match(html, /<meta property="og:description" content="Template og description" \/>/);
    assert.match(html, /<meta name="twitter:description" content="Template twitter description" \/>/);
    assert.match(html, /<noscript>/, 'English keeps its noscript fallback');
    assert.match(html, /rel="canonical" href="https:\/\/www.worldmonitor.app\/"/);
    assert.match(html, /hreflang="es" href="https:\/\/www.worldmonitor.app\/es\/"/);
    assert.equal((html.match(/rel="canonical"/g) ?? []).length, 1);
    assert.match(html, /data-wm-prerender-lang="en"/);
  });
});
