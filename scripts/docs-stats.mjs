#!/usr/bin/env node
/**
 * docs-stats — single source of truth for the capability counts quoted in docs.
 *
 * Default mode  : recompute every stat from code and write docs/generated/stats.json.
 * --check mode  : recompute, then assert that every registered doc claim still
 *                 matches the live number. Exits non-zero on drift (CI gate).
 *
 * Why this exists: capability counts (map layers, services, protos, locales,
 * workflows, freshness sources, feeds) were hand-maintained across README,
 * ARCHITECTURE.md, and docs/*.mdx and drifted independently. Every number a doc
 * quotes must be derivable here and registered in CLAIMS below.
 *
 * Stats are parsed from source text (no TS execution / import-graph / env deps)
 * so this runs anywhere Node runs, including bare CI.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const dirsIn = (p) =>
  readdirSync(join(ROOT, p), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const filesIn = (p) =>
  readdirSync(join(ROOT, p), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
const entriesIn = (p) => readdirSync(join(ROOT, p), { withFileTypes: true }).map((e) => e.name);

function walk(rel, out = []) {
  for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(child, out);
    else out.push(child);
  }
  return out;
}

function computeStats() {
  // ---- Map layers (src/config/map-layer-definitions.ts) ----
  const mld = read('src/config/map-layer-definitions.ts');
  const registryBlock = mld.slice(mld.indexOf('LAYER_REGISTRY'), mld.indexOf('VARIANT_LAYER_ORDER'));
  const layerDefinitions = (registryBlock.match(/^\s+\w+:\s+def\(/gm) || []).length;

  const variantBlock = mld.slice(mld.indexOf('VARIANT_LAYER_ORDER'), mld.indexOf('export function getLayersForVariant'));
  const variantLayers = {};
  for (const m of variantBlock.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    variantLayers[m[1]] = (m[2].match(/'[^']+'/g) || []).length;
  }
  const variantCount = Object.keys(variantLayers).length;

  // ---- Root app directories used by AGENTS.md and CONTRIBUTING.md ----
  const componentTopLevelTsFiles = filesIn('src/components').filter((f) => f.endsWith('.ts')).length;
  const serviceTopLevelEntries = entriesIn('src/services').length;
  const apiEndpointEntries = entriesIn('api').filter(
    (f) => !f.startsWith('_') && !/\.test\./.test(f) && !/\.d\.ts$/.test(f) && !/\.json$/.test(f),
  ).length;

  // ---- Protos & services (proto/**) ----
  const protoFiles = walk('proto').filter((f) => f.endsWith('.proto'));
  const protoServices = protoFiles
    .map((f) => (read(f).match(/^service\s+\w+/gm) || []).length)
    .reduce((a, b) => a + b, 0);
  const protoDomainFolders = dirsIn('proto/worldmonitor').length;

  // ---- Generated OpenAPI service specs (docs/api/*Service.openapi.yaml) ----
  const openapiServiceSpecs = filesIn('docs/api').filter((f) => /Service\.openapi\.yaml$/.test(f)).length;

  // ---- Server domain handlers (server/worldmonitor/*/) ----
  const serverDomains = dirsIn('server/worldmonitor').length;

  // ---- Locales (src/locales/*.json) ----
  const locales = filesIn('src/locales').filter((f) => f.endsWith('.json')).length;

  // ---- CI workflows (.github/workflows/*.yml) ----
  const workflows = filesIn('.github/workflows').filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();

  // ---- Freshness-tracked sources (src/services/data-freshness.ts) ----
  const dfs = read('src/services/data-freshness.ts');
  const dfsStart = dfs.indexOf('const SOURCE_METADATA');
  const dfsClass = dfs.indexOf('class ', dfsStart);
  const metaBlock = dfs.slice(dfsStart, dfsClass >= 0 ? dfsClass : dfs.length);
  const freshnessSources = (metaBlock.match(/^\s+\w+:\s*\{\s*name:/gm) || []).length;
  const freshnessRequiredForRisk = (metaBlock.match(/requiredForRisk:\s*true/g) || []).length;

  // ---- Feed definitions (src/config/feeds.ts) — floor metric ----
  const feedDefinitions = (read('src/config/feeds.ts').match(/name:\s*'/g) || []).length;

  // ---- Operational source counts used by data-source and methodology docs ----
  const airportCount = (read('src/config/airports.ts').match(/\biata:\s*'/g) || []).length;

  const financeGeo = read('src/config/finance-geo.ts');
  const stockExchangeStart = financeGeo.indexOf('export const STOCK_EXCHANGES');
  const stockExchangeEnd = financeGeo.indexOf('export const FINANCIAL_CENTERS');
  if (stockExchangeStart === -1 || stockExchangeEnd === -1 || stockExchangeEnd <= stockExchangeStart) {
    throw new Error('docs-stats: could not isolate STOCK_EXCHANGES block in src/config/finance-geo.ts');
  }
  const stockExchangeBlock = financeGeo.slice(stockExchangeStart, stockExchangeEnd);
  const stockExchangeCount = (stockExchangeBlock.match(/\bid:\s*'/g) || []).length;
  const centralBankStart = financeGeo.indexOf('export const CENTRAL_BANKS');
  const centralBankEnd = financeGeo.indexOf('export const COMMODITY_HUBS');
  if (centralBankStart === -1 || centralBankEnd === -1 || centralBankEnd <= centralBankStart) {
    throw new Error('docs-stats: could not isolate CENTRAL_BANKS block in src/config/finance-geo.ts');
  }
  const centralBankBlock = financeGeo.slice(centralBankStart, centralBankEnd);
  const centralBankInstitutionCount = (centralBankBlock.match(/\bid:\s*'/g) || []).length;

  const telegram = JSON.parse(read('data/telegram-channels.json'));
  const telegramFullEnabled = Array.isArray(telegram?.channels?.full)
    ? telegram.channels.full.filter((c) => c?.enabled !== false)
    : [];
  const telegramFullTierCounts = telegramFullEnabled.reduce((acc, c) => {
    const tier = String(c?.tier ?? 'unknown');
    acc[tier] = (acc[tier] || 0) + 1;
    return acc;
  }, {});

  const leaderBlock = read('src/services/trending-keywords.ts').match(
    /const\s+LEADER_NAMES\s*(?::[^=]*)?\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!leaderBlock) {
    throw new Error('docs-stats: could not find LEADER_NAMES array in src/services/trending-keywords.ts');
  }
  const leaderNames = (leaderBlock[1].match(/'[^']+'/g) || []).length;

  const populationBlock = read('src/services/population-exposure.ts').match(
    /const PRIORITY_COUNTRIES:[\s\S]*?=\s*\{([\s\S]*?)\n\};/,
  );
  const populationPriorityCountries = populationBlock
    ? (populationBlock[1].match(/^\s+[A-Z]{3}:\s*\{/gm) || []).length
    : 0;

  return {
    _generated: 'scripts/docs-stats.mjs — do not edit by hand; run `npm run docs:stats`',
    layerDefinitions,
    variantLayers,
    variantCount,
    componentTopLevelTsFiles,
    serviceTopLevelEntries,
    apiEndpointEntries,
    protoFiles: protoFiles.length,
    protoServices,
    protoDomainFolders,
    openapiServiceSpecs,
    serverDomains,
    locales,
    workflows,
    workflowCount: workflows.length,
    freshnessSources,
    freshnessRequiredForRisk,
    feedDefinitions,
    airportCount,
    stockExchangeCount,
    centralBankInstitutionCount,
    telegramFullEnabledChannels: telegramFullEnabled.length,
    telegramFullTierCounts,
    leaderNames,
    populationPriorityCountries,
  };
}

/**
 * Registered doc claims. Each entry pins one number in one doc to a live stat.
 * `value` returns the expected number; `min:true` treats the doc number as a
 * floor (doc says "500+" → live must be >= 500). The regex must capture the
 * number in group 1 and be unique enough to match the intended sentence.
 */
function claims(s) {
  return [
    { file: 'README.md', re: /(\d+)\s+map layer types/, value: s.layerDefinitions },
    { file: 'README.md', re: /Protocol Buffers \((\d+)\s+protos/, value: s.protoFiles },
    { file: 'README.md', re: /(\d+)\s+services\)/, value: s.protoServices },
    { file: 'README.md', re: /(\d+)\s+languages/, value: s.locales },
    { file: 'README.md', re: /(\d+)\+\s+curated news feeds/, value: s.feedDefinitions, min: true },
    { file: 'README.md', re: /(\d+)\s+stock exchanges/, value: s.stockExchangeCount },
    { file: 'docs/overview.mdx', re: /(\d+)\+\s+curated news feeds/, value: s.feedDefinitions, min: true },

    // ---- Root contributor/agent docs ----
    { file: 'AGENTS.md', re: /with (\d+)\s+top-level TypeScript component files/, value: s.componentTopLevelTsFiles },
    { file: 'AGENTS.md', re: /(\d+)\+\s+Vercel Edge API endpoint entries/, value: s.apiEndpointEntries, min: true },
    { file: 'AGENTS.md', re: /(\d+)\s+freshness-tracked source groups/, value: s.freshnessSources },
    { file: 'AGENTS.md', re: /components\/\s+# (\d+)\s+top-level TypeScript component files/, value: s.componentTopLevelTsFiles },
    { file: 'AGENTS.md', re: /services\/\s+# Business logic \((\d+)\s+service modules and domain directories\)/, value: s.serviceTopLevelEntries },
    { file: 'CONTRIBUTING.md', re: /Service and message definitions across (\d+)\s+domains/, value: s.protoDomainFolders },
    { file: 'CONTRIBUTING.md', re: /produces (\d+)\s+app variants/, value: s.variantCount },
    { file: 'CONTRIBUTING.md', re: /UI components — (\d+)\s+top-level TypeScript component files/, value: s.componentTopLevelTsFiles },
    { file: 'CONTRIBUTING.md', re: /i18n JSON files \((\d+)\s+languages\)/, value: s.locales },
    { file: 'CONTRIBUTING.md', re: /Sebuf handler implementations for all (\d+)\s+server handler domains/, value: s.serverDomains },
    { file: 'CONTRIBUTING.md', re: /expand our (\d+)\+\s+feed collection/, value: s.feedDefinitions, min: true },

    { file: 'docs/architecture.mdx', re: /(\d+)\s+service domains, and (?:\d+)\s+map layers/, value: s.protoServices },
    { file: 'docs/architecture.mdx', re: /(\d+)\s+map layers\./, value: s.layerDefinitions },
    { file: 'docs/architecture.mdx', re: /\*\*(\d+)\s+service domains\*\* cover/, value: s.protoServices },
    { file: 'docs/architecture.mdx', re: /All (\d+)\s+map layer toggle definitions/, value: s.layerDefinitions },

    { file: 'docs/map-engine.mdx', re: /\*\*(\d+)\s+data layers\*\*/, value: s.layerDefinitions },
    { file: 'docs/map-engine.mdx', re: /full \((\d+)\b/, value: s.variantLayers.full },
    { file: 'docs/map-engine.mdx', re: /tech \((\d+)\b/, value: s.variantLayers.tech },
    { file: 'docs/map-engine.mdx', re: /finance \((\d+)\b/, value: s.variantLayers.finance },
    { file: 'docs/map-engine.mdx', re: /happy \((\d+)\b/, value: s.variantLayers.happy },
    { file: 'docs/map-engine.mdx', re: /commodity \((\d+)\b/, value: s.variantLayers.commodity },
    { file: 'docs/map-engine.mdx', re: /energy \((\d+)\b/, value: s.variantLayers.energy },

    { file: 'docs/features.mdx', re: /(\d+)\s+data layers/, value: s.layerDefinitions },

    { file: 'docs/agent-discovery.mdx', re: /all (\d+)\s+services/, value: s.protoServices },
    { file: 'docs/api-reference.mdx', re: /all (\d+)\s+services/, value: s.protoServices },

    { file: 'docs/data-sources.mdx', re: /monitors (\d+)\s+data sources/, value: s.freshnessSources },
    { file: 'docs/data-sources.mdx', re: /across (\d+)\s+monitored airports/, value: s.airportCount },
    { file: 'docs/data-sources.mdx', re: /^(\d+)\s+airports across 5 regions/m, value: s.airportCount },
    { file: 'docs/data-sources.mdx', re: /(\d+)\s+global stock exchanges/, value: s.stockExchangeCount },
    { file: 'docs/data-sources.mdx', re: /(\d+)\s+central-bank and supranational finance institutions/, value: s.centralBankInstitutionCount },
    { file: 'docs/features.mdx', re: /signals from (\d+)\s+central-bank and supranational finance institutions/, value: s.centralBankInstitutionCount },
    { file: 'docs/overview.mdx', re: /(\d+)\s+central-bank and supranational finance institutions/, value: s.centralBankInstitutionCount },
    { file: 'docs/architecture.mdx', re: /stock exchanges \((\d+)\)/, value: s.stockExchangeCount },
    { file: 'docs/architecture.mdx', re: /central-bank and supranational finance institutions \((\d+)\)/, value: s.centralBankInstitutionCount },
    { file: 'docs/COMMUNITY-PROMOTION-GUIDE.md', re: /"(\d+)\s+global stock exchanges mapped/, value: s.stockExchangeCount },
    { file: 'docs/COMMUNITY-PROMOTION-GUIDE.md', re: /Finance variant with (\d+)\s+exchanges/, value: s.stockExchangeCount },
    { file: 'docs/PRESS_KIT.md', re: /\| Stock exchanges mapped \| (\d+) \|/, value: s.stockExchangeCount },
    { file: 'public/llms-full.txt', re: /Stock Exchanges\*\*: (\d+)\s+global exchanges/, value: s.stockExchangeCount },
    { file: 'public/llms-full.txt', re: /Central Banks & Institutions\*\*: (\d+)\s+central-bank and supranational finance institutions/, value: s.centralBankInstitutionCount },
    { file: 'public/llms-full.txt', re: /Unique layers: (\d+)\s+stock exchanges/, value: s.stockExchangeCount },
    { file: 'public/llms-full.txt', re: /Unique layers: \d+\s+stock exchanges, \d+\s+financial centers, (\d+)\s+central-bank and supranational finance institutions/, value: s.centralBankInstitutionCount },
    { file: 'docs/data-sources.mdx', re: /^(\d+)\s+enabled channels in the default `full` Telegram channel set/m, value: s.telegramFullEnabledChannels },
    { file: 'docs/data-sources.mdx', re: /\*\*Tier 1\*\* \| (\d+)\s+\|/, value: s.telegramFullTierCounts['1'] },
    { file: 'docs/data-sources.mdx', re: /\*\*Tier 2\*\* \| (\d+)\s+\|/, value: s.telegramFullTierCounts['2'] },
    { file: 'docs/data-sources.mdx', re: /\*\*Tier 3\*\* \| (\d+)\s+\|/, value: s.telegramFullTierCounts['3'] },
    { file: 'docs/algorithms.mdx', re: /local (\d+)-country priority population table/, value: s.populationPriorityCountries },
    { file: 'docs/algorithms.mdx', re: /and (\d+)\s+tracked world-leader names/, value: s.leaderNames },

    // ---- Blog posts (blog-site/) — capability counts quoted in evergreen developer/overview posts ----
    { file: 'blog-site/src/content/blog/build-on-worldmonitor-developer-api-open-source.md', re: /typed API: (\d+)\s+services/, value: s.protoServices },
    { file: 'blog-site/src/content/blog/build-on-worldmonitor-developer-api-open-source.md', re: /typed API: \d+\s+services, (\d+)\s+proto files/, value: s.protoFiles },
    { file: 'blog-site/src/content/blog/build-on-worldmonitor-developer-api-open-source.md', re: /\*\*(\d+)\s+proto files\*\* defining/, value: s.protoFiles },
    { file: 'blog-site/src/content/blog/build-on-worldmonitor-developer-api-open-source.md', re: /\*\*(\d+)\s+typed service domains\*\*/, value: s.protoServices },
    // Heading labels the table below it, which is enumerated from server/worldmonitor/* dirs → pin to serverDomains (not protoServices; the two equal 34 today but a domain with two `service` blocks would diverge them).
    { file: 'blog-site/src/content/blog/build-on-worldmonitor-developer-api-open-source.md', re: /##\s+(\d+)\s+Service Domains/, value: s.serverDomains },
    { file: 'blog-site/src/content/blog/build-on-worldmonitor-developer-api-open-source.md', re: /Protocol Buffers \((\d+)\s+files\)/, value: s.protoFiles },
    { file: 'blog-site/src/content/blog/build-on-worldmonitor-developer-api-open-source.md', re: /worldmonitor\)\. (\d+)\s+services, \d+\s+proto files, and a global/, value: s.protoServices },
    { file: 'blog-site/src/content/blog/build-on-worldmonitor-developer-api-open-source.md', re: /worldmonitor\)\. \d+\s+services, (\d+)\s+proto files, and a global/, value: s.protoFiles },
    { file: 'blog-site/src/content/blog/what-is-worldmonitor-real-time-global-intelligence.md', re: /typed APIs \((\d+)\s+proto files, \d+\s+services\)/, value: s.protoFiles },
    { file: 'blog-site/src/content/blog/what-is-worldmonitor-real-time-global-intelligence.md', re: /typed APIs \(\d+\s+proto files, (\d+)\s+services\)/, value: s.protoServices },
    { file: 'blog-site/src/content/blog/ai-powered-intelligence-without-the-cloud.md', re: /architecture \((\d+)\s+proto files, \d+\s+typed services\)/, value: s.protoFiles },
    { file: 'blog-site/src/content/blog/ai-powered-intelligence-without-the-cloud.md', re: /architecture \(\d+\s+proto files, (\d+)\s+typed services\)/, value: s.protoServices },
    { file: 'blog-site/src/content/blog/worldmonitor-vs-traditional-intelligence-tools.md', re: /using the (\d+)\s+typed API services/, value: s.protoServices },
  ];
}

function main() {
  const check = process.argv.includes('--check');
  const stats = computeStats();

  if (!check) {
    mkdirSync(join(ROOT, 'docs/generated'), { recursive: true });
    writeFileSync(join(ROOT, 'docs/generated/stats.json'), JSON.stringify(stats, null, 2) + '\n');
    console.log('docs/generated/stats.json written:');
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  const failures = [];

  // Every CI workflow must be documented in ARCHITECTURE.md's CI/CD table.
  const arch = read('ARCHITECTURE.md');
  for (const wf of stats.workflows) {
    if (!arch.includes('`' + wf + '`')) {
      failures.push(`ARCHITECTURE.md: CI workflow \`${wf}\` is not listed in the CI/CD table`);
    }
  }

  for (const c of claims(stats)) {
    let text;
    try {
      text = read(c.file);
    } catch {
      failures.push(`${c.file}: file not found`);
      continue;
    }
    const m = text.match(c.re);
    if (!m) {
      failures.push(`${c.file}: claim pattern ${c.re} not found (expected ${c.value})`);
      continue;
    }
    const found = Number(m[1]);
    const ok = c.min ? found <= c.value : found === c.value;
    if (!ok) {
      failures.push(
        `${c.file}: doc says ${found}, code says ${c.value}${c.min ? ' (floor)' : ''} — pattern ${c.re}`,
      );
    }
  }

  if (failures.length) {
    console.error(`docs-stats --check FAILED (${failures.length}):`);
    for (const f of failures) console.error('  ✗ ' + f);
    console.error('\nFix the doc number, or run `npm run docs:stats` if the code total legitimately changed.');
    process.exit(1);
  }
  console.log(`docs-stats --check OK — ${claims(stats).length} doc claims match code.`);
}

main();
