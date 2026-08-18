import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSupportedLanguages } from '../scripts/docs-stats.mjs';
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

interface ParsedDocument {
  canonical: string;
  description: string;
  hreflang: Map<string, string>;
  hreflangEntries: Array<[string, string]>;
  htmlLang: string;
  indexable: boolean;
  structuredLanguages: string[];
  title: string;
  visibleHeading: string;
}

interface StaticResponse {
  body: string;
  status: number;
}

const DEPLOYED_ROUTES = new Map<string, string>([
  ['/', 'public/pro/welcome.html'],
  ['/dashboard', 'index.html'],
  ['/pro', 'public/pro/index.html'],
]);

const SOURCE_DOCUMENTS = [
  { path: 'index.html', canonical: 'https://www.worldmonitor.app/dashboard' },
  { path: 'pro-test/welcome.html', canonical: 'https://www.worldmonitor.app/' },
  { path: 'pro-test/index.html', canonical: 'https://www.worldmonitor.app/pro' },
  { path: 'public/pro/welcome.html', canonical: 'https://www.worldmonitor.app/' },
  { path: 'public/pro/index.html', canonical: 'https://www.worldmonitor.app/pro' },
];

function tagText(html: string, tag: string): string {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return (match?.[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function attribute(tag: string, name: string): string {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1] ?? '';
}

function parseDocument(html: string): ParsedDocument {
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
  const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
  const canonicalTag = linkTags.find((tag) => attribute(tag, 'rel') === 'canonical') ?? '';
  const descriptionTag = html.match(/<meta\b[^>]*\bname="description"[^>]*>/i)?.[0] ?? '';
  const robotsTag = html.match(/<meta\b[^>]*\bname="robots"[^>]*>/i)?.[0] ?? '';
  const hreflangEntries = linkTags
    .filter((tag) => attribute(tag, 'rel') === 'alternate' && attribute(tag, 'hreflang'))
    .map((tag): [string, string] => [attribute(tag, 'hreflang'), attribute(tag, 'href')]);
  const hreflang = new Map(hreflangEntries);
  const structuredLanguages = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .flatMap((match) => {
      const value = JSON.parse(match[1])?.inLanguage;
      return Array.isArray(value) ? value : value ? [value] : [];
    });

  return {
    canonical: attribute(canonicalTag, 'href'),
    description: attribute(descriptionTag, 'content'),
    hreflang,
    hreflangEntries,
    htmlLang: attribute(htmlTag, 'lang'),
    indexable: !/\bnoindex\b/i.test(attribute(robotsTag, 'content')),
    structuredLanguages,
    title: tagText(html, 'title'),
    visibleHeading: tagText(html, 'h1'),
  };
}

function supportedLanguages(): string[] {
  const languages = parseSupportedLanguages(read('src/services/i18n.ts'));
  assert.ok(languages, 'src/services/i18n.ts must expose the literal supported-locale registry');
  return languages;
}

const staticRouteBodies = new Map<string, string>();

async function fetchStaticRoute(input: string): Promise<StaticResponse> {
  const url = new URL(input);
  const file = DEPLOYED_ROUTES.get(url.pathname);
  if (!file) return { status: 404, body: '' };
  const body = staticRouteBodies.get(file) ?? read(file);
  staticRouteBodies.set(file, body);
  return { status: 200, body };
}

function discoverySignature(document: ParsedDocument): string {
  return [document.title, document.description, document.visibleHeading]
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .join('\n');
}

async function validateHreflangCluster(
  seedUrl: string,
  fetchPage: (url: string) => Promise<StaticResponse>,
): Promise<string[]> {
  const failures: string[] = [];
  const seedResponse = await fetchPage(seedUrl);
  if (seedResponse.status !== 200) return [`seed ${seedUrl} returned HTTP ${seedResponse.status}`];
  const seed = parseDocument(seedResponse.body);
  const entries = seed.hreflangEntries;
  const fetched = new Map<string, ParsedDocument>();
  const seenCodes = new Set<string>();

  for (const [code] of entries) {
    if (seenCodes.has(code)) failures.push(`${code}: duplicate hreflang entry`);
    seenCodes.add(code);
  }

  for (const [code, href] of entries) {
    let targetUrl: URL;
    try {
      targetUrl = new URL(href);
    } catch {
      failures.push(`${code}: target is not an absolute crawlable URL`);
      continue;
    }
    if (targetUrl.protocol !== 'https:' || targetUrl.hash) {
      failures.push(`${code}: target is not a stable HTTPS URL`);
    }
    if (targetUrl.searchParams.has('lang')) {
      failures.push(`${code}: query-string locale targets are application state, not indexable alternates`);
    }

    const response = await fetchPage(targetUrl.href);
    if (response.status !== 200) {
      failures.push(`${code}: target returned HTTP ${response.status}`);
      continue;
    }
    const target = parseDocument(response.body);
    fetched.set(code, target);
    if (new Set(target.hreflangEntries.map(([targetCode]) => targetCode)).size !== target.hreflangEntries.length) {
      failures.push(`${code}: target publishes duplicate hreflang entries`);
    }
    if (!target.indexable) failures.push(`${code}: target is noindex`);
    if (target.canonical !== targetUrl.href) failures.push(`${code}: target is not self-canonical`);
    if (code !== 'x-default' && target.htmlLang.split('-')[0] !== code.split('-')[0]) {
      failures.push(`${code}: target html lang does not match hreflang`);
    }
    if (!target.visibleHeading || !target.title || !target.description) {
      failures.push(`${code}: target lacks localized visible content or metadata`);
    }
    for (const [reciprocalCode, reciprocalHref] of entries) {
      if (target.hreflang.get(reciprocalCode) !== reciprocalHref) {
        failures.push(`${code}: target does not publish the reciprocal ${reciprocalCode} alternate`);
      }
    }
  }

  const english = fetched.get('en');
  if (english) {
    const englishSignature = discoverySignature(english);
    for (const [code, target] of fetched) {
      if (code !== 'en' && code !== 'x-default' && discoverySignature(target) === englishSignature) {
        failures.push(`${code}: visible content and metadata are not localized`);
      }
    }
  }

  return failures;
}

// public/pro/ is built by `npm run build:pro`, not committed (#6898): skip when the
// checkout has not built it, fail when WM_EXPECT_BUILT_OUTPUT=1 says CI did.
describe('international SEO application-locale mode (#5666)', { skip: shouldSkipProBuiltOutput() }, () => {
  guardProBuiltOutput();

  it('publishes only x-default and English at each self-canonical application URL', () => {
    for (const { path, canonical } of SOURCE_DOCUMENTS) {
      const document = parseDocument(read(path));
      assert.equal(document.htmlLang, 'en', `${path}: raw document language`);
      assert.equal(document.canonical, canonical, `${path}: canonical`);
      assert.deepEqual(
        document.hreflangEntries,
        [['x-default', canonical], ['en', canonical]],
        `${path}: indexable hreflang cluster`,
      );
      assert.equal(document.indexable, true, `${path}: canonical document remains indexable`);
      assert.ok(document.structuredLanguages.every((language) => language === 'en'), `${path}: structured language must describe the raw English document`);
    }
  });

  it('serves LTR, RTL, and every supported ?lang request as 200 application state on the base canonical', async () => {
    const locales = supportedLanguages();
    assert.ok(locales.includes('fr'), 'LTR representative locale must stay registered');
    assert.ok(locales.includes('ar'), 'RTL representative locale must stay registered');

    for (const locale of locales) {
      for (const [route] of DEPLOYED_ROUTES) {
        const request = new URL(route, 'https://www.worldmonitor.app');
        request.searchParams.set('lang', locale);
        const response = await fetchStaticRoute(request.href);
        assert.equal(response.status, 200, `${request.href}: HTTP status`);
        const document = parseDocument(response.body);
        assert.equal(document.canonical, new URL(route, 'https://www.worldmonitor.app').href, `${request.href}: base canonical`);
        assert.ok(!document.hreflang.has(locale) || locale === 'en', `${request.href}: locale must not be advertised as an indexable alternate`);
      }
    }
  });

  it('accepts the deployed English hreflang clusters', async () => {
    for (const [route] of DEPLOYED_ROUTES) {
      const url = new URL(route, 'https://www.worldmonitor.app').href;
      assert.deepEqual(await validateHreflangCluster(url, fetchStaticRoute), [], url);
    }
  });

  it('rejects an advertised pseudo-localized query target', async () => {
    const english = `<!doctype html><html lang="en"><head>
      <title>English title</title>
      <meta name="description" content="English description" />
      <link rel="canonical" href="https://example.test/" />
      <link rel="alternate" hreflang="x-default" href="https://example.test/" />
      <link rel="alternate" hreflang="en" href="https://example.test/duplicate" />
      <link rel="alternate" hreflang="en" href="https://example.test/" />
      <link rel="alternate" hreflang="fr" href="https://example.test/?lang=fr" />
      </head><body><main><h1>English heading</h1></main></body></html>`;
    const failures = await validateHreflangCluster(
      'https://example.test/',
      async () => ({ status: 200, body: english }),
    );
    assert.ok(failures.some((failure) => failure.includes('duplicate hreflang')));
    assert.ok(failures.some((failure) => failure.includes('query-string locale targets')));
    assert.ok(failures.some((failure) => failure.includes('html lang does not match')));
    assert.ok(failures.some((failure) => failure.includes('not self-canonical')));
    assert.ok(failures.some((failure) => failure.includes('not localized')));
  });

  it('never lists pseudo-localized query URLs in sitemap or robots output', () => {
    assert.doesNotMatch(read('public/sitemap.xml'), /[?&]lang=/i);
    assert.doesNotMatch(read('public/robots.www.txt'), /[?&]lang=/i);
  });
});
