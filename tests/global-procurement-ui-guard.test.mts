import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const economicPanel = readFileSync(resolve(import.meta.dirname, '../src/components/EconomicPanel.ts'), 'utf8');
const panel = readFileSync(resolve(import.meta.dirname, '../src/components/GlobalProcurementPanel.ts'), 'utf8');
const loader = readFileSync(resolve(import.meta.dirname, '../src/app/data-loader.ts'), 'utf8');
const app = readFileSync(resolve(import.meta.dirname, '../src/App.ts'), 'utf8');
const panelLayout = readFileSync(resolve(import.meta.dirname, '../src/app/panel-layout.ts'), 'utf8');
const panelConfig = readFileSync(resolve(import.meta.dirname, '../src/config/panels.ts'), 'utf8');
const bootstrap = readFileSync(resolve(import.meta.dirname, '../api/bootstrap.js'), 'utf8');
const service = readFileSync(resolve(import.meta.dirname, '../src/services/global-tenders.ts'), 'utf8');
const premiumPaths = readFileSync(resolve(import.meta.dirname, '../src/shared/premium-paths.ts'), 'utf8');
const entitlementCheck = readFileSync(resolve(import.meta.dirname, '../server/_shared/entitlement-check.ts'), 'utf8');
const envExample = readFileSync(resolve(import.meta.dirname, '../.env.example'), 'utf8');
const docs = readFileSync(resolve(import.meta.dirname, '../docs/global-procurement-intelligence.mdx'), 'utf8');

test('dedicated procurement panel supports discovery controls, pagination, and safe official links', () => {
  assert.match(panel, /id: 'global-procurement'/);
  assert.match(panel, /premium: 'locked'/);
  assert.match(panel, /data-procurement-query/);
  assert.match(panel, /data-procurement-country/);
  assert.match(panel, /data-procurement-source/);
  assert.match(panel, /data-procurement-sort/);
  assert.match(panel, /data-procurement-load-more/);
  assert.match(panel, /nextCursor/);
  assert.match(panel, /const safeUrl = sanitizeUrl\(tender\.officialUrl\)/);
  assert.match(panel, /href="\$\{safeUrl\}" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.match(panel, /Technology relevance \(keyword evidence, not bidding eligibility\):/);
  assert.match(panel, /CLOSING SOON/);
  assert.doesNotMatch(economicPanel, /procurement|GlobalTender|tenderData|updateTenders|clearTenders/i);
});

test('procurement loading reports an explicit partial or unavailable state to StatusPanel', () => {
  assert.match(loader, /updateApi\('Global Procurement'/);
  assert.match(loader, /\['partial', 'stale'\]\.includes\(data\.availability\) \? 'warning' : 'ok'/);
  assert.match(loader, /procurementPanel\.showUnavailable\(\)/);
});

test('procurement keeps the complete canonical feed behind the paginated RPC', () => {
  assert.doesNotMatch(bootstrap, /globalTenders:\s*'economic:global-tenders:v1'/);
  assert.doesNotMatch(bootstrap, /'globalTenders'/);
  assert.doesNotMatch(service, /getHydratedData\('globalTenders'\)/);
  assert.match(service, /client\.listGlobalTenders\(request/);
});

test('procurement is Pro-enforced and free clients neither fetch nor retain its data', () => {
  assert.match(premiumPaths, /'\/api\/economic\/v1\/list-global-tenders'/);
  assert.match(entitlementCheck, /'\/api\/economic\/v1\/list-global-tenders': 1/);

  assert.match(panelConfig, /'global-procurement': \{ name: 'Global Procurement', enabled: true, priority: 1, premium: 'locked'/);
  assert.match(panelConfig, /apiKeyPanels = \[[^\]]*'global-procurement'/s);
  assert.match(panelLayout, /WEB_PREMIUM_PANELS = new Set\(\[[^\]]*'global-procurement'/s);
  assert.match(panelLayout, /lazyDefaultPanel\('global-procurement'.*GlobalProcurementPanel/s);

  assert.match(loader, /if \(!hasPremiumAccess\(\)\) \{\s*procurementPanel\?\.clear\(\);\s*return;\s*\}/);
  assert.match(loader, /hasPremiumAccess\(\) && shouldLoad\('global-procurement'\)/);
  assert.match(app, /shouldPrime\('global-procurement'\) && hasPremiumAccess\(\)[\s\S]*primeTask\('global-tenders'/);
  assert.match(app, /condition: \(\) => hasPremiumAccess\(\) && this\.isPanelNearViewport\('global-procurement'\)/);
  assert.match(app, /void this\.dataLoader\.loadGlobalTenders\(\)/);
  assert.match(app, /void this\.dataLoader\.clearGlobalTenders\(\)/);

  assert.match(service, /persistCache: false/);
  assert.match(service, /cacheKey:/);
  assert.match(service, /tenderBreaker\.clearCache\(\)/);
  assert.match(panel, /public clear\(\): void \{[\s\S]*this\.data = null;/);
});

test('procurement deployment documentation identifies the sole optional source credential', () => {
  assert.match(envExample, /SAM_GOV_API_KEY=/);
  assert.match(docs, /SAM_GOV_API_KEY/);
  assert.match(docs, /TED, Contracts Finder, CanadaBuys, GETS, and World Bank do not require API keys/);
});

test('the documented AusTender blocker stays documented and no scraper ships in its place', () => {
  const seeder = readFileSync(resolve(import.meta.dirname, '../scripts/seed-global-tenders.mjs'), 'utf8');
  const normalizer = readFileSync(resolve(import.meta.dirname, '../scripts/_global-tenders.mjs'), 'utf8');
  assert.match(docs, /### Australia: AusTender adapter is blocked/);
  assert.match(docs, /no close|closing date/i);
  assert.match(seeder, /austender.*BLOCKED on the provider/s);

  // Any AusTender identifier, host, or notice-path reference in CODE (the
  // blocker comment legitimately cites the feed URLs, so comments are
  // stripped first) means a scraper or adapter is being reintroduced without
  // going through the documented unblock path.
  const scraperPattern = /austender|tenders\.gov\.au|atm\/(show|searchdescription|docshow)/i;
  const stripComments = (source: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(stripComments(seeder), scraperPattern);
  assert.doesNotMatch(stripComments(normalizer), scraperPattern);
  assert.doesNotMatch(panel, /austender|tenders\.gov\.au/i);

  // Self-test: the pattern must catch casing and naming evasions, so a green
  // guard cannot coexist with a renamed or relocated scraper.
  for (const evasion of [
    'function scrapeAusTender() {}',
    "fetch('https://www.TENDERS.gov.au/Atm/Show/abc')",
    'const url = `${base}/ATM/SHOW/${id}`',
    'AUSTENDER_FEED_URL',
  ]) {
    assert.match(evasion, scraperPattern, `guard pattern must catch: ${evasion}`);
  }
});

test('technology-relevance control filters by evidence and never claims bidding eligibility', () => {
  assert.match(panel, /data-procurement-tech-relevant/);
  assert.match(panel, /Technology relevant only/);
  assert.match(panel, /TECH_RELEVANCE_MIN_SCORE = 30/);
  assert.match(panel, /minAutomationScore: formData\.get\('techRelevant'\) \? TECH_RELEVANCE_MIN_SCORE : 0/);
  assert.match(panel, /Keyword relevance evidence only — not an indication of bidding eligibility/);
  assert.doesNotMatch(panel, /eligible to bid|bidding eligibility confirmed|qualified to bid/i);
  assert.match(service, /minAutomationScore: 0/);
  assert.match(docs, /min_automation_score/);
  assert.match(docs, /Technology relevant only/);
  assert.match(docs, /never assert that an AI system, agent, or vendor is eligible to bid/);
});
