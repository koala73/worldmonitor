// Conversion audit item 9 (2026-11-06): trust signals on / and /pro.
// - The /pro source ticker listed outlets with no label, so Bloomberg, CNBC and
//   Nikkei read like partner logos. It now says "Sources we monitor" and links
//   to the /sources/ directory, and it drops names World Monitor does not
//   ingest (ACLED has no access or licence; the rest have no feed).
// - The homepage proof rail put "5 independent alert origins" next to "846
//   attributed providers"; the small number undercut the big one. That slot
//   now shows the MCP tool count.
// - Visible copy spelled the brand both "WorldMonitor" and "World Monitor".

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');
const app = read('pro-test/src/App.tsx');
const marquee = app.slice(app.indexOf('const SourceMarquee = '), app.indexOf('const ProShowcase = '));
const localeDir = join(repoRoot, 'pro-test/src/locales');
const locales = readdirSync(localeDir).filter((file) => file.endsWith('.json'));

function strings(node, path = '') {
  if (typeof node === 'string') return [[path, node]];
  return Object.entries(node).flatMap(([key, value]) => strings(value, path ? `${path}.${key}` : key));
}

describe('/pro source ticker', () => {
  it('names only sources World Monitor ingests', () => {
    for (const name of ['ACLED', 'BGPStream', 'BleepingComputer', 'Hellenic Shipping News', 'Maritime Executive', 'The Record']) {
      assert.ok(!marquee.includes(`"${name}"`), `${name} is not an ingested source`);
    }
  });

  it('labels the ticker as monitored sources and links the directory', () => {
    assert.match(marquee, /href="\/sources\/"[^>]*>[\s\S]*?\{t\('sourceMarquee\.label'\)\}/);
    for (const file of locales) {
      const label = JSON.parse(readFileSync(join(localeDir, file), 'utf8')).sourceMarquee?.label;
      assert.ok(label?.trim(), `${file} translates sourceMarquee.label`);
    }
    assert.equal(JSON.parse(read('pro-test/src/locales/en.json')).sourceMarquee.label, 'Sources we monitor');
  });
});

describe('homepage proof rail', () => {
  const hero = read('pro-test/src/welcome/Hero.tsx');
  const rail = hero.slice(hero.indexOf('const HERO_PROOF_STATS = '), hero.indexOf('];', hero.indexOf('const HERO_PROOF_STATS = ')));

  it('shows the MCP tool count instead of the alert-origin count', () => {
    assert.doesNotMatch(rail, /alertOrigins|s15l/);
    assert.match(rail, /depthProofStats\.mcpTools\), labelKey: 'welcome\.depth\.s12l'/);
  });
});

describe('brand spelling', () => {
  it('writes "World Monitor" in every locale string', () => {
    for (const file of locales) {
      for (const [key, value] of strings(JSON.parse(readFileSync(join(localeDir, file), 'utf8')))) {
        assert.doesNotMatch(value, /WorldMonitor/, `${file} ${key}`);
      }
    }
  });

  it('writes "World Monitor" in the footers and plan descriptions', () => {
    for (const path of ['pro-test/src/App.tsx', 'pro-test/src/components/Footer.tsx']) {
      assert.doesNotMatch(read(path), /&copy;[^<]*WorldMonitor/, path);
    }
    assert.doesNotMatch(read('scripts/generate-product-config.mjs'), /product on WorldMonitor data/);
    assert.doesNotMatch(read('pro-test/src/generated/tiers.json'), /WorldMonitor/);
  });
});

// /pro factual-drift pass (2026-11-19): each claim below was checked against
// the code or a live probe before the copy changed.
describe('/pro factual claims', () => {
  const proHtml = read('pro-test/index.html');
  const welcomeHtml = read('pro-test/welcome.html');
  const apiSection = app.slice(app.indexOf('const ApiSection = '), app.indexOf('const EnterpriseShowcase = ') > 0 ? app.indexOf('const EnterpriseShowcase = ') : undefined);
  const showcase = app.slice(app.indexOf('const ProShowcase = '), app.indexOf('const AudiencePersonas = '));
  const socialProof = app.slice(app.indexOf('const SocialProof = '), app.indexOf('const SocialProof = ') + 1200);

  it('never names ACLED as a source (no access or licence)', () => {
    for (const file of locales) {
      for (const [key, value] of strings(JSON.parse(readFileSync(join(localeDir, file), 'utf8')))) {
        assert.doesNotMatch(value, /ACLED/, `${file} ${key}`);
      }
    }
    assert.doesNotMatch(proHtml, /ACLED|acleddata/, 'pro-test/index.html');
    assert.doesNotMatch(welcomeHtml, /ACLED|acleddata/, 'pro-test/welcome.html');
  });

  it('shows a REST example that exists: /api/<domain>/v1 route, X-WorldMonitor-Key, wm_ key', () => {
    assert.match(apiSection, /api\.worldmonitor\.app\/api\/intelligence\/v1\/list-cross-source-signals/);
    assert.match(apiSection, /X-WorldMonitor-Key: wm_/);
    assert.doesNotMatch(apiSection, /\/v1\/intelligence\/convergence|Authorization: Bearer|wm_live_/);
    // Field names in the sample body come from ListCrossSourceSignalsResponse.
    for (const field of ['signals', 'severityScore', 'contributingTypes', 'evaluatedAt']) {
      assert.ok(apiSection.includes(`"${field}"`), `sample body names ${field}`);
    }
  });

  it('takes the source count from the generated depth stats, not a hand-typed number', () => {
    assert.doesNotMatch(socialProof, /"500\+"/);
    assert.match(socialProof, /depthProofStats\.providers/);
  });

  it('does not call shipped features a roadmap', () => {
    assert.doesNotMatch(showcase, /roadmapNote/);
    assert.equal(JSON.parse(read('pro-test/src/locales/en.json')).proShowcase.roadmapNote, undefined);
  });

  it('lists Microsoft Teams wherever delivery channels are listed', () => {
    const en = JSON.parse(read('pro-test/src/locales/en.json'));
    const channelLists = strings(en).filter(([, value]) => /Discord/.test(value));
    assert.ok(channelLists.length >= 4, 'channel lists found');
    for (const [key, value] of channelLists) {
      assert.match(value, /Teams/, key);
    }
    assert.match(showcase, /label: "Teams"/);
    for (const [path, html] of [['pro-test/index.html', proHtml], ['pro-test/welcome.html', welcomeHtml]]) {
      for (const [list] of html.matchAll(/.{0,80}Discord/g)) {
        assert.match(list, /Teams/, `${path}: ${list}`);
      }
    }
  });

  it('names every live variant in the static fallback, including Energy Monitor', () => {
    assert.match(proHtml, /href="https:\/\/energy\.worldmonitor\.app\/dashboard"[^>]*>Energy Monitor<\/a>/);
  });

  it('gives every JSON-LD Offer a description', () => {
    const blocks = [...proHtml.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
      .filter((b) => b && Array.isArray(b.offers));
    assert.ok(blocks.length > 0);
    for (const offer of blocks.flatMap((b) => b.offers)) {
      assert.ok(offer.description?.trim(), `${offer.name} has a description`);
    }
  });

  it('keeps the ProShowcase items at one heading level', () => {
    assert.doesNotMatch(showcase, /<h4/);
  });
});
