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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const dirsIn = (p) =>
  readdirSync(join(ROOT, p), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const filesIn = (p) =>
  readdirSync(join(ROOT, p), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
const entriesIn = (p) => readdirSync(join(ROOT, p), { withFileTypes: true }).map((e) => e.name);
const parseJson = (p) => JSON.parse(read(p));

function sorted(items) {
  return [...items].sort();
}

function sameStringSet(a, b) {
  const left = sorted(a);
  const right = sorted(b);
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

function describeSetDelta(found, expected) {
  const foundSet = new Set(found);
  const expectedSet = new Set(expected);
  const missing = sorted(expected.filter((v) => !foundSet.has(v)));
  const extra = sorted(found.filter((v) => !expectedSet.has(v)));
  return [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    extra.length ? `extra: ${extra.join(', ')}` : '',
  ].filter(Boolean).join('; ');
}

function extractSingleQuotedValue(text, name) {
  const match = text.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*'([^']+)'`));
  if (!match) throw new Error(`docs-stats: could not find ${name}`);
  return match[1];
}

function findTopLevelObjectBlocks(source) {
  const starts = [...source.matchAll(/^ {2}\{$/gm)].map((m) => m.index);
  return starts.map((start) => {
    const close = source.slice(start).search(/^ {2}\},?$/m);
    if (close === -1) return source.slice(start);
    return source.slice(start, start + close);
  });
}

function parseMcpAppsInventory({
  uiRegistrySource = read('api/mcp/ui/registry.ts'),
  shellSource = read('api/mcp/ui/shell.ts'),
  rpcToolsSource = read('api/mcp/registry/rpc-tools.ts'),
  cacheToolsSource = read('api/mcp/registry/cache-tools.ts'),
} = {}) {
  const uiConstToUri = new Map(
    [...uiRegistrySource.matchAll(/^export\s+const\s+(\w+_UI_URI)\s*=\s*'([^']+)';/gm)]
      .map((m) => [m[1], m[2]]),
  );
  if (uiConstToUri.size === 0) {
    throw new Error('docs-stats: could not parse MCP Apps ui:// URI constants');
  }

  const registryBlockMatch = uiRegistrySource.match(/export const UI_RESOURCE_REGISTRY:[\s\S]*?=\s*\[([\s\S]*?)\n\];/);
  if (!registryBlockMatch) {
    throw new Error('docs-stats: could not parse UI_RESOURCE_REGISTRY');
  }
  const registryEntries = [...registryBlockMatch[1].matchAll(
    /uri:\s*(\w+_UI_URI),\s*\n\s*name:\s*'((?:\\'|[^'])*)',\s*\n\s*description:\s*\n\s*'((?:\\'|[^'])*)',/g,
  )].map((m) => ({
    uriConst: m[1],
    uri: uiConstToUri.get(m[1]) ?? m[1],
    name: m[2].replace(/\\'/g, "'"),
    description: m[3].replace(/\\'/g, "'"),
  }));
  const registryConsts = registryEntries.map((entry) => entry.uriConst);
  const uiConsts = [...uiConstToUri.keys()];
  if (!sameStringSet(registryConsts, uiConsts)) {
    throw new Error(
      `docs-stats: UI_RESOURCE_REGISTRY entries do not match ui:// constants (${describeSetDelta(registryConsts, uiConsts)})`,
    );
  }

  const toolLinks = [];
  for (const source of [rpcToolsSource, cacheToolsSource]) {
    for (const block of findTopLevelObjectBlocks(source)) {
      const name = block.match(/^\s+name:\s*'([^']+)'/m)?.[1];
      const uriConst = block.match(/^\s+_uiResourceUri:\s*(\w+_UI_URI),/m)?.[1];
      if (name && uriConst) {
        const uri = uiConstToUri.get(uriConst);
        if (!uri) throw new Error(`docs-stats: tool ${name} links unknown MCP App URI constant ${uriConst}`);
        toolLinks.push({ tool: name, uriConst, uri });
      }
    }
  }
  for (const [label, values] of [
    ['tool', toolLinks.map((entry) => entry.tool)],
    ['ui resource', toolLinks.map((entry) => entry.uri)],
  ]) {
    const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
    if (duplicates.length) {
      throw new Error(`docs-stats: duplicate MCP Apps ${label} links: ${sorted([...new Set(duplicates)]).join(', ')}`);
    }
  }

  const toolByUri = new Map(toolLinks.map((entry) => [entry.uri, entry.tool]));
  const apps = registryEntries.map((entry) => ({
    ...entry,
    tool: toolByUri.get(entry.uri) ?? null,
  }));
  const unlinked = apps.filter((entry) => !entry.tool).map((entry) => entry.uri);
  if (unlinked.length) {
    throw new Error(`docs-stats: MCP Apps resources missing linked tools: ${unlinked.join(', ')}`);
  }

  return {
    specVersion: extractSingleQuotedValue(shellSource, 'UI_PROTOCOL_VERSION'),
    mimeType: extractSingleQuotedValue(shellSource, 'UI_RESOURCE_MIME_TYPE'),
    apps,
    uiResources: apps.map((entry) => entry.uri),
    linkedTools: apps.map((entry) => entry.tool),
    toolLinks: apps.map((entry) => ({ tool: entry.tool, uri: entry.uri })),
  };
}

// ---- /api/bootstrap cache contract (api/bootstrap.js) ----
//
// Four doc surfaces publish the concrete Cache-Control / CDN-Cache-Control
// values `/api/bootstrap` emits per auth kind. During #5386/#5791 all four were
// wrong at once, in two different ways, while every test stayed green:
// api/bootstrap-auth.test.mjs pins the handler exhaustively and nothing pinned
// the prose. A silently wrong published header is worse than an undocumented
// one, because integrators act on it — so parse what the handler emits here.

// Brace-balanced rather than a `\{([\s\S]*?)\n\};` match. The non-greedy form
// silently runs PAST its own object whenever the declaration is not in the
// expected multi-line shape — `= {};` on one line captured everything up to
// some later block's closing brace and parsed that instead. Counting braces
// bounds the body to the object actually declared. Safe here because these
// blocks hold only header strings, which contain no braces.
function parseObjectBlockBody(source, declaration, label) {
  const start = source.search(new RegExp(`${declaration}\\s*=\\s*\\{`));
  if (start === -1) throw new Error(`docs-stats: could not parse ${label}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`docs-stats: could not parse ${label} (unbalanced braces)`);
}

function parseCacheHeaderMap(source, name) {
  const body = parseObjectBlockBody(source, `const ${name}`, `${name} in api/bootstrap.js`);
  const map = Object.fromEntries(
    [...body.matchAll(/^ {2}(\w+):\s*'([^']+)',$/gm)].map((m) => [m[1], m[2]]),
  );
  for (const tier of ['fast', 'slow']) {
    if (!map[tier]) throw new Error(`docs-stats: ${name} in api/bootstrap.js is missing the ${tier} tier`);
  }
  return map;
}

// The docs quote ONE directive out of a full header value (`max-age=60`, not
// the whole `max-age=60, stale-while-revalidate=120, ...` string), so compare
// directive-for-directive instead of substring-matching the header.
function cacheDirective(headerValue, name, label) {
  const found = headerValue.split(',').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!found) throw new Error(`docs-stats: ${label} has no ${name} directive (${headerValue})`);
  return found;
}

function parseBootstrapCacheContract(source = read('api/bootstrap.js')) {
  const tierCache = parseCacheHeaderMap(source, 'TIER_CACHE');
  const tierCdnCache = parseCacheHeaderMap(source, 'TIER_CDN_CACHE');

  const profilesBody = parseObjectBlockBody(
    source, 'const ON_DEMAND_CACHE_PROFILES', 'ON_DEMAND_CACHE_PROFILES in api/bootstrap.js',
  );
  const onDemandProfiles = {};
  for (const [, key, body] of profilesBody.matchAll(/^ {2}(\w+):\s*\{([\s\S]*?)^ {2}\},$/gm)) {
    const browser = body.match(/browser:\s*'([^']+)'/)?.[1];
    const cdn = body.match(/cdn:\s*'([^']+)'/)?.[1];
    if (!browser || !cdn) {
      throw new Error(`docs-stats: ON_DEMAND_CACHE_PROFILES.${key} must declare both browser and cdn`);
    }
    onDemandProfiles[key] = { browser, cdn };
  }
  // The entry pattern above is layout-sensitive (two-space key, `},` on its own
  // line). A miss returns {} rather than throwing, which would silently disable
  // the per-key doc check below while the pages still publish those headers —
  // green while dead. Cross-check against a layout-independent count so a
  // reformat (profile collapsed to one line, block re-indented) throws instead.
  // A genuinely empty block counts 0 against 0 and stays legal.
  const declaredProfiles = (profilesBody.match(/\bcdn:/g) || []).length;
  if (Object.keys(onDemandProfiles).length !== declaredProfiles) {
    throw new Error(
      `docs-stats: parsed ${Object.keys(onDemandProfiles).length} ON_DEMAND_CACHE_PROFILES entries but found `
      + `${declaredProfiles} cdn declarations in api/bootstrap.js — the profile block layout changed`,
    );
  }

  // `const cacheTier = tier ?? (auth.kind === 'public-on-demand' ? 'slow' : null)`
  // — the tier a marked single-key on-demand URL inherits when it declares no
  // profile of its own.
  const onDemandDefaultTier = source.match(
    /const cacheTier = tier \?\? \(auth\.kind === 'public-on-demand' \? '(\w+)' : null\);/,
  )?.[1];
  if (!onDemandDefaultTier || !tierCache[onDemandDefaultTier]) {
    throw new Error('docs-stats: could not parse the public-on-demand default cache tier in api/bootstrap.js');
  }

  const successBlock = source.match(/function successCacheHeaders\([\s\S]*?\n\}/)?.[0];
  if (!successBlock) throw new Error('docs-stats: could not parse successCacheHeaders in api/bootstrap.js');

  // The tier-less fallbacks — what `?keys=weatherAlerts&public=1` gets, since a
  // marked single-key URL carries no `tier` param and weatherAlerts declares no
  // on-demand profile.
  //
  // Searched inside successCacheHeaders, not the whole file: these `[\s\S]*?`
  // patterns will happily run past a deleted fallback and match some unrelated
  // `|| '...'` elsewhere in the module, reporting a confident wrong value.
  // Bounding them to the emitter means a removed fallback throws.
  const defaultCacheControl = successBlock.match(/const cacheControl = [\s\S]*?\|\|\s*'([^']+)';/)?.[1];
  const defaultCdnTier = successBlock.match(/'CDN-Cache-Control':[\s\S]*?\|\|\s*TIER_CDN_CACHE\.(\w+),/)?.[1];
  if (!defaultCacheControl || !defaultCdnTier || !tierCdnCache[defaultCdnTier]) {
    throw new Error('docs-stats: could not parse the tier-less public cache fallbacks in api/bootstrap.js');
  }

  // Pin the WIRING, not just the constants. Parsing `cacheTier` proves the
  // value is COMPUTED, never that it reaches the emitter: swap the call to
  // `successCacheHeaders(tier, ...)` and on-demand inheritance stops while
  // every parsed value stays byte-identical and the pages keep publishing it.
  // Same for the profile lookup — without it the per-key overrides are dead.
  // A source gate cannot prove runtime behavior (api/bootstrap-auth.test.mjs
  // does that); this narrows the gap between "the constant says X" and "the
  // handler emits X" to a rename, which throws rather than passing quietly.
  if (!/successCacheHeaders\(\s*cacheTier,\s*auth\.kind,\s*cors,\s*onDemandKey,?\s*\)/.test(source)) {
    throw new Error(
      'docs-stats: api/bootstrap.js no longer calls successCacheHeaders(cacheTier, auth.kind, cors, onDemandKey) '
      + '— the documented per-auth-kind cache contract may no longer be what it emits',
    );
  }
  if (!/ON_DEMAND_CACHE_PROFILES\[onDemandKey\]/.test(successBlock)) {
    throw new Error('docs-stats: successCacheHeaders no longer looks up ON_DEMAND_CACHE_PROFILES[onDemandKey]');
  }

  // The non-cacheable branches. These objects contain no nested braces, so the
  // first `};` closes each one.
  //
  // Counting BRANCHES, not distinct values: deduping to a set meant deleting
  // one of the two no-store returns (making the anonymous weather URL
  // cacheable — the whole of #5386) left `['no-store']` and passed. And the
  // pages promise these shapes emit "no CDN cache headers", which nothing
  // checked, so adding CDN-Cache-Control to a no-store branch passed too.
  const returnBodies = [...successBlock.matchAll(/return \{([\s\S]*?)\};/g)].map((m) => m[1]);
  const nonCacheableReturns = returnBodies.filter((body) => /'Cache-Control':\s*'/.test(body));
  if (nonCacheableReturns.length !== 2) {
    throw new Error(
      `docs-stats: successCacheHeaders has ${nonCacheableReturns.length} literal Cache-Control branches, expected 2 `
      + '(non-public, and public-but-not-shared-cacheable) — a changed branch set needs a doc review',
    );
  }
  const withCdnHeader = nonCacheableReturns.filter((body) => body.includes('CDN-Cache-Control'));
  if (withCdnHeader.length) {
    throw new Error(
      'docs-stats: a non-cacheable successCacheHeaders branch now sets CDN-Cache-Control, but the docs promise '
      + 'these shapes emit no CDN cache headers',
    );
  }
  const nonCacheableValues = [...new Set(
    nonCacheableReturns.map((body) => body.match(/'Cache-Control':\s*'([^']+)'/)[1]),
  )];
  if (nonCacheableValues.length !== 1) {
    throw new Error(
      `docs-stats: successCacheHeaders emits ${nonCacheableValues.length} distinct non-cacheable Cache-Control values `
      + `(${nonCacheableValues.join(', ')}); expected one`,
    );
  }

  return {
    tierCache,
    tierCdnCache,
    onDemandProfiles,
    onDemandDefaultTier,
    defaultCacheControl,
    defaultCdnTier,
    nonCacheable: nonCacheableValues[0],
  };
}

// Tier membership for the bootstrap keys the API docs name by hand. Text-parsed
// like everything else here rather than imported, so the gate keeps running on
// bare Node with no import graph to resolve.
function parseBootstrapKeyTiers(source = read('shared/bootstrap-tier-keys.js')) {
  const tiers = {};
  for (const [tier, constName] of [
    ['fast', 'FAST_KEY_NAMES'],
    ['slow', 'SLOW_KEY_NAMES'],
    ['on-demand', 'ON_DEMAND_KEY_NAMES'],
  ]) {
    const block = source.match(new RegExp(`const ${constName} = new Set\\(\\[([\\s\\S]*?)\\n\\]\\);`));
    if (!block) throw new Error(`docs-stats: could not parse ${constName} in shared/bootstrap-tier-keys.js`);
    for (const m of block[1].matchAll(/'([^']+)'/g)) {
      // Last-write-wins would make this parser disagree with the runtime in the
      // one case that matters: tierForKey() tests fast FIRST, so a key in both
      // FAST and ON_DEMAND resolves to fast at runtime and would resolve to
      // on-demand here. Duplicate membership is a registry bug either way.
      if (tiers[m[1]]) {
        throw new Error(
          `docs-stats: bootstrap key "${m[1]}" is registered in both ${tiers[m[1]]} and ${tier} tiers`,
        );
      }
      tiers[m[1]] = tier;
    }
  }
  if (Object.keys(tiers).length === 0) {
    throw new Error('docs-stats: shared/bootstrap-tier-keys.js yielded no key tier assignments');
  }
  return tiers;
}

function parseJsonLdBlocks(html) {
  return [...html.matchAll(/<script\s+type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)]
    .map((m) => JSON.parse(m[1]));
}

function validateIndexLanguageMetadata(_stats, html = read('index.html')) {
  const failures = [];

  const alternateLinks = [...html.matchAll(/<link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"\s*\/>/g)]
    .map((m) => ({ code: m[1], href: m[2] }));
  const canonicalHref = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"\s*\/>/)?.[1] ?? null;
  if (!canonicalHref) {
    failures.push('index.html: canonical link not found');
  }

  const defaultLink = alternateLinks.find((l) => l.code === 'x-default');
  if (!defaultLink) {
    failures.push('index.html: x-default hreflang link not found');
  } else {
    let parsed;
    try {
      parsed = new URL(defaultLink.href);
    } catch {
      failures.push('index.html: x-default hreflang href is not a valid URL');
    }
    if (parsed?.searchParams.has('lang')) {
      failures.push('index.html: x-default hreflang href must not set ?lang');
    }
  }

  const hreflangCodes = alternateLinks.map((link) => link.code);
  const expectedDiscoveryCodes = ['x-default', 'en'];
  if (!sameStringSet(hreflangCodes, expectedDiscoveryCodes)) {
    failures.push(`index.html: hreflang set must contain only x-default and en (${describeSetDelta(hreflangCodes, expectedDiscoveryCodes)})`);
  }

  for (const link of alternateLinks) {
    let parsed;
    try {
      parsed = new URL(link.href);
    } catch {
      failures.push(`index.html: ${link.code} hreflang href must be an absolute URL`);
    }
    if (parsed?.searchParams.has('lang')) {
      failures.push(`index.html: query-string locale URLs must not be advertised (${link.code})`);
    }
    if (canonicalHref && link.href !== canonicalHref) {
      failures.push(`index.html: ${link.code} hreflang href must equal the canonical URL`);
    }
  }

  let jsonLd;
  try {
    jsonLd = parseJsonLdBlocks(html);
  } catch (error) {
    failures.push(`index.html: JSON-LD could not be parsed (${error.message})`);
    return failures;
  }

  const webSite = jsonLd.find((o) => o?.['@type'] === 'WebSite');
  if (!webSite) {
    failures.push('index.html: WebSite JSON-LD block not found');
  } else {
    const inLanguage = Array.isArray(webSite.inLanguage) ? webSite.inLanguage : [webSite.inLanguage].filter(Boolean);
    if (!sameStringSet(inLanguage, ['en'])) {
      failures.push(`index.html: WebSite inLanguage must describe the raw English document (${describeSetDelta(inLanguage, ['en'])})`);
    }
  }

  // The "<N> language support with RTL" featureList count is validated by the
  // index.html claims() entry (single source of truth), so it is not re-checked
  // here to avoid a duplicate assertion of the same string against the same value.

  return failures;
}

// Cross-check the runtime i18next allow-list (SUPPORTED_LANGUAGES in
// src/services/i18n.ts) against the filesystem locale set. index.html now
// accepts `?lang=<code>` as user-facing application state; if a code is present
// on disk but missing from SUPPORTED_LANGUAGES, shared links silently fall back
// to English even though the translation exists.
function parseSupportedLanguages(i18nSource) {
  const block = i18nSource.match(/const\s+SUPPORTED_LANGUAGES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!block) return null;
  return (block[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
}

function validateSupportedLanguagesRegistry(stats, i18nSource = read('src/services/i18n.ts')) {
  const supported = parseSupportedLanguages(i18nSource);
  if (!supported) {
    return ['src/services/i18n.ts: could not parse SUPPORTED_LANGUAGES array'];
  }
  if (!sameStringSet(supported, stats.localeCodes)) {
    return [`src/services/i18n.ts: SUPPORTED_LANGUAGES does not match src/locales (${describeSetDelta(supported, stats.localeCodes)})`];
  }
  return [];
}

function makefileVar(text, name) {
  const match = text.match(new RegExp(`^${name}\\s*:=\\s*(\\S+)`, 'm'));
  if (!match) throw new Error(`docs-stats: could not find ${name} in Makefile`);
  return match[1];
}

function walk(rel, out = []) {
  for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(child, out);
    else out.push(child);
  }
  return out;
}

function computeStats() {
  const makefile = read('Makefile');
  const serverCard = parseJson('public/.well-known/mcp/server-card.json');
  const mcpApps = parseMcpAppsInventory();

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

  // ---- Panel subclasses across src/components (ARCHITECTURE.md system diagram) ----
  const panelClasses = walk('src/components')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .reduce((n, f) => n + (read(f).match(/class\s+\w+\s+extends\s+Panel\b/g) || []).length, 0);

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

  // ---- User-facing locales (src/locales/*.json, excluding shell fragments) ----
  const localeCodes = filesIn('src/locales')
    .filter((f) => f.endsWith('.json') && !f.endsWith('.shell.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  const locales = localeCodes.length;

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

  // LEADER_NAMES moved to shared/keyword-spike-core.js (issue #5697) so the
  // server-side get_keyword_spikes MCP tool shares the tracked list.
  const leaderBlock = read('shared/keyword-spike-core.js').match(
    /const\s+LEADER_NAMES\s*(?::[^=]*)?\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!leaderBlock) {
    throw new Error('docs-stats: could not find LEADER_NAMES array in shared/keyword-spike-core.js');
  }
  const leaderNames = (leaderBlock[1].match(/'[^']+'/g) || []).length;

  // Table moved to the shared client/server core in #5696. Fail closed like
  // LEADER_NAMES above: the previous `: 0` fallback silently zeroed the
  // published claim when the file moved, turning a stale doc number into an
  // unnoticed "code says 0".
  const populationBlock = read('shared/analysis-population-exposure.ts').match(
    /const PRIORITY_COUNTRIES:[\s\S]*?=\s*\{([\s\S]*?)\n\};/,
  );
  if (!populationBlock) {
    throw new Error('docs-stats: could not find PRIORITY_COUNTRIES in shared/analysis-population-exposure.ts');
  }
  const populationPriorityCountries = (populationBlock[1].match(/^\s+[A-Z]{3}:\s*\{/gm) || []).length;

  return {
    _generated: 'scripts/docs-stats.mjs — do not edit by hand; run `npm run docs:stats`',
    layerDefinitions,
    variantLayers,
    variantCount,
    componentTopLevelTsFiles,
    serviceTopLevelEntries,
    apiEndpointEntries,
    panelClasses,
    protoFiles: protoFiles.length,
    protoServices,
    protoDomainFolders,
    openapiServiceSpecs,
    serverDomains,
    localeCodes,
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
    sebufVersion: makefileVar(makefile, 'SEBUF_VERSION'),
    mcpToolCount: Array.isArray(serverCard.tools) ? serverCard.tools.length : 0,
    mcpApps,
    mcpAppCount: mcpApps.apps.length,
    mcpAppUiResources: mcpApps.uiResources,
    mcpAppLinkedTools: mcpApps.linkedTools,
    bootstrapCache: parseBootstrapCacheContract(),
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
    { file: 'public/llms.txt', re: /(\d+)\s+languages with RTL support/, value: s.locales },
    { file: 'public/llms-full.txt', re: /(\d+)\s+languages with RTL support/, value: s.locales },
    { file: 'README.md', re: /(\d+)\+\s+curated news feeds/, value: s.feedDefinitions, min: true },
    { file: 'README.md', re: /(\d+)\s+stock exchanges/, value: s.stockExchangeCount },
    { file: 'docs/overview.mdx', re: /(\d+)\+\s+curated news feeds/, value: s.feedDefinitions, min: true },

    // ---- Translated READMEs ----
    // Same claims as README.md, pinned in each language. Without these the
    // translations silently rot: README.zh-CN.md sat at 279 protos while
    // README.md had already moved to 281.
    { file: 'README.zh-CN.md', re: /(\d+)\s*种地图图层/, value: s.layerDefinitions },
    { file: 'README.zh-CN.md', re: /Protocol Buffers（(\d+)\s*个 proto/, value: s.protoFiles },
    { file: 'README.zh-CN.md', re: /(\d+)\s*项服务/, value: s.protoServices },
    { file: 'README.zh-CN.md', re: /(\d+)\s*种语言/, value: s.locales },
    { file: 'README.zh-CN.md', re: /(\d+)\+\s*精选新闻源/, value: s.feedDefinitions, min: true },
    { file: 'README.zh-CN.md', re: /(\d+)\s*家证券交易所/, value: s.stockExchangeCount },
    { file: 'README.ja-JP.md', re: /(\d+)\s*種類のマップレイヤー/, value: s.layerDefinitions },
    { file: 'README.ja-JP.md', re: /Protocol Buffers \((\d+)\s*proto/, value: s.protoFiles },
    { file: 'README.ja-JP.md', re: /(\d+)\s*サービス\)/, value: s.protoServices },
    { file: 'README.ja-JP.md', re: /(\d+)\s*言語対応/, value: s.locales },
    { file: 'README.ja-JP.md', re: /(\d+)\s*以上の厳選ニュースフィード/, value: s.feedDefinitions, min: true },
    { file: 'README.ja-JP.md', re: /(\d+)\s*の証券取引所/, value: s.stockExchangeCount },

    // ---- Root contributor/agent/security docs ----
    { file: 'AGENTS.md', re: /with (\d+)\s+top-level TypeScript component files/, value: s.componentTopLevelTsFiles },
    { file: 'AGENTS.md', re: /(\d+)\+\s+Vercel Edge API endpoint entries/, value: s.apiEndpointEntries, min: true },
    { file: 'AGENTS.md', re: /(\d+)\s+freshness-tracked source groups/, value: s.freshnessSources },
    { file: 'AGENTS.md', re: /components\/\s+# (\d+)\s+top-level TypeScript component files/, value: s.componentTopLevelTsFiles },
    { file: 'AGENTS.md', re: /services\/\s+# Business logic \((\d+)\s+service modules and domain directories\)/, value: s.serviceTopLevelEntries },
    { file: 'AGENTS.md', re: /requires buf \+ sebuf (v\d+\.\d+\.\d+) plugins/, value: s.sebufVersion },

    { file: 'ARCHITECTURE.md', re: /base class \((\d+)\s+classes\b/, value: s.panelClasses },
    { file: 'CONTRIBUTING.md', re: /Service and message definitions across (\d+)\s+domains/, value: s.protoDomainFolders },
    { file: 'CONTRIBUTING.md', re: /produces (\d+)\s+app variants/, value: s.variantCount },
    { file: 'CONTRIBUTING.md', re: /UI components — (\d+)\s+top-level TypeScript component files/, value: s.componentTopLevelTsFiles },
    { file: 'CONTRIBUTING.md', re: /i18n JSON files \((\d+)\s+languages\)/, value: s.locales },
    { file: 'CONTRIBUTING.md', re: /Sebuf handler implementations for all (\d+)\s+server handler domains/, value: s.serverDomains },
    { file: 'CONTRIBUTING.md', re: /currently \*\*(v\d+\.\d+\.\d+)\*\*/, value: s.sebufVersion },
    { file: 'CONTRIBUTING.md', re: /expand our (\d+)\+\s+feed collection/, value: s.feedDefinitions, min: true },
    { file: 'SECURITY.md', re: /All (\d+)\s+domain APIs are served through Sebuf/, value: s.serverDomains },
    { file: 'index.html', re: /"(\d+)\s+language support with RTL"/, value: s.locales },

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
    { file: 'docs/api-reference.mdx', re: /all (\d+)\s+generated services/, value: s.protoServices },

    { file: 'docs/mcp-overview.mdx', re: /same (\d+)\s+tools/, value: s.mcpToolCount },
    { file: 'docs/mcp-apps.mdx', re: /current fleet ships (\d+)\s+MCP Apps/, value: s.mcpAppCount },
    { file: 'docs/mcp-quickstart.mdx', re: /WorldMonitor exposes (\d+)\s+live tools/, value: s.mcpToolCount },
    { file: 'docs/mcp-quickstart.mdx', re: /receives (\d+)\s+compressed tool descriptions/, value: s.mcpToolCount },
    { file: 'public/mcp-server.md', re: /server ships \*\*(\d+)\s+tools\*\*/, value: s.mcpToolCount },

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

function findDocsJsonPages(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) findDocsJsonPages(item, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const value of Object.values(node)) findDocsJsonPages(value, out);
  return out;
}

function validateMcpAppsDocs(stats) {
  const failures = [];
  const docsPage = read('docs/mcp-apps.mdx');
  const overview = read('docs/mcp-overview.mdx');
  const publicMcp = read('public/mcp-server.md');
  const docsJson = parseJson('docs/docs.json');
  const serverCard = parseJson('public/.well-known/mcp/server-card.json');

  if (!findDocsJsonPages(docsJson).includes('mcp-apps')) {
    failures.push('docs/docs.json: MCP Apps page `mcp-apps` is not in navigation');
  }

  const cardApps = serverCard.metadata?.mcpApps;
  if (!cardApps || cardApps.supported !== true) {
    failures.push('public/.well-known/mcp/server-card.json: metadata.mcpApps.supported must be true');
  } else {
    if (cardApps.extension !== 'io.modelcontextprotocol/ui') {
      failures.push(`public/.well-known/mcp/server-card.json: metadata.mcpApps.extension is ${cardApps.extension}`);
    }
    if (cardApps.specVersion !== stats.mcpApps.specVersion) {
      failures.push(
        `public/.well-known/mcp/server-card.json: metadata.mcpApps.specVersion is ${cardApps.specVersion}, code says ${stats.mcpApps.specVersion}`,
      );
    }
    if (cardApps.uiResourceMimeType !== stats.mcpApps.mimeType) {
      failures.push(
        `public/.well-known/mcp/server-card.json: metadata.mcpApps.uiResourceMimeType is ${cardApps.uiResourceMimeType}, code says ${stats.mcpApps.mimeType}`,
      );
    }
    if (!sameStringSet(cardApps.uiResources ?? [], stats.mcpAppUiResources)) {
      failures.push(
        `public/.well-known/mcp/server-card.json: metadata.mcpApps.uiResources drift (${describeSetDelta(cardApps.uiResources ?? [], stats.mcpAppUiResources)})`,
      );
    }
  }

  for (const { tool, uri } of stats.mcpApps.toolLinks) {
    for (const [file, text] of [
      ['docs/mcp-apps.mdx', docsPage],
      ['docs/mcp-overview.mdx', overview],
      ['public/mcp-server.md', publicMcp],
    ]) {
      if (!text.includes(uri)) failures.push(`${file}: missing MCP Apps ui resource ${uri}`);
      if (!text.includes(tool)) failures.push(`${file}: missing MCP Apps linked tool ${tool}`);
    }
  }

  for (const app of stats.mcpApps.apps) {
    if (!docsPage.includes(app.name)) failures.push(`docs/mcp-apps.mdx: missing MCP Apps display name ${app.name}`);
  }

  if (!docsPage.includes(stats.mcpApps.specVersion)) {
    failures.push(`docs/mcp-apps.mdx: missing MCP Apps spec version ${stats.mcpApps.specVersion}`);
  }
  if (!docsPage.includes(stats.mcpApps.mimeType)) {
    failures.push(`docs/mcp-apps.mdx: missing MCP Apps mime type ${stats.mcpApps.mimeType}`);
  }

  return failures;
}

const BOOTSTRAP_CACHE_DOC_FILES = [
  'docs/api-platform.mdx',
  'docs/usage-rate-limits.mdx',
  'docs/zh/api-platform.mdx',
  'docs/zh/usage-rate-limits.mdx',
];

// Every published cache claim lives in ONE markdown bullet per page, so the
// patterns below run against that single line, located by this anchor.
//
// Two separate properties keep this from degrading into "the value appears
// somewhere on the page", which is how #5791 stayed green:
//
//   1. Each pattern CAPTURES the value at its documented position, with `[^`]*`
//      gaps that cannot jump a backtick — so no claim can be satisfied by its
//      neighbour's token. `s-maxage=600` is simultaneously the fast tier's CDN
//      value and part of the weatherAlerts header, so a substring search stays
//      green with the two transposed; a positional capture does not.
//   2. Line scoping pins WHICH bullet was read. Combined with the
//      exactly-one-anchor rule below, a stale duplicate of the prose elsewhere
//      on the page can neither satisfy the gate nor hide behind the live copy.
//
// Anchored on the ASCII URL literals instead of the surrounding prose, so one
// set of patterns reads the English pages and their zh mirrors alike.
//
// The anchor is the tier PAIR, not `?tier=fast&public=1` alone: api-platform.mdx
// also name-drops the fast URL in an earlier bullet, and anchoring on that would
// scope every pattern to a line carrying none of the values.
const BOOTSTRAP_CACHE_ANCHOR = '`?tier=fast&public=1` / `?tier=slow&public=1`';

const BOOTSTRAP_CACHE_CHECKS = [
  {
    re: /`\?tier=fast&public=1` \/ `\?tier=slow&public=1`[^`]*`(max-age=[^`]+)` \/ `(max-age=[^`]+)`[^`]*CDN[^`]*`(s-maxage=[^`]+)` \/ `(s-maxage=[^`]+)`/,
    what: 'the ?tier=fast|slow&public=1 browser/CDN values',
    slots: [
      ['tierFastBrowser', '?tier=fast&public=1 browser Cache-Control'],
      ['tierSlowBrowser', '?tier=slow&public=1 browser Cache-Control'],
      ['tierFastCdn', '?tier=fast&public=1 CDN-Cache-Control'],
      ['tierSlowCdn', '?tier=slow&public=1 CDN-Cache-Control'],
    ],
  },
  {
    re: /`\?keys=<onDemandName>&public=1`[^`]*\b(fast|slow)\b[^`]*`(max-age=[^`]+)`[^`]*CDN[^`]*`(s-maxage=[^`]+)`/,
    what: 'the inherited on-demand single-key profile',
    slots: [
      ['onDemandDefaultTier', 'tier inherited by ?keys=<onDemandName>&public=1'],
      ['onDemandBrowser', '?keys=<onDemandName>&public=1 browser Cache-Control'],
      ['onDemandCdn', '?keys=<onDemandName>&public=1 CDN-Cache-Control'],
    ],
  },
  {
    re: /`\?keys=weatherAlerts&public=1`[^`]*`Cache-Control: ([^`]+)`[^`]*\b(fast|slow)\b[^`]*CDN/,
    what: 'the ?keys=weatherAlerts&public=1 values',
    slots: [
      ['defaultCacheControl', '?keys=weatherAlerts&public=1 Cache-Control'],
      ['defaultCdnTier', '?keys=weatherAlerts&public=1 CDN tier'],
    ],
  },
  {
    // The anonymous UNMARKED weather URL, which is the enumeration's last item
    // on every page — `?keys=weatherAlerts` closed by a backtick, so it never
    // matches the `&public=1` variant above.
    re: /`\?keys=weatherAlerts`[^`]*`Cache-Control: ([^`]+)`/,
    what: 'the non-shared-cacheable value',
    slots: [['nonCacheable', 'Cache-Control for every non-shared-cacheable shape']],
  },
];

function expectedBootstrapCacheDocValues(cache) {
  const browser = (tier) => cacheDirective(cache.tierCache[tier], 'max-age', `TIER_CACHE.${tier}`);
  const cdn = (tier) => cacheDirective(cache.tierCdnCache[tier], 's-maxage', `TIER_CDN_CACHE.${tier}`);
  return {
    tierFastBrowser: browser('fast'),
    tierSlowBrowser: browser('slow'),
    tierFastCdn: cdn('fast'),
    tierSlowCdn: cdn('slow'),
    onDemandDefaultTier: cache.onDemandDefaultTier,
    onDemandBrowser: browser(cache.onDemandDefaultTier),
    onDemandCdn: cdn(cache.onDemandDefaultTier),
    defaultCacheControl: cache.defaultCacheControl,
    defaultCdnTier: cache.defaultCdnTier,
    nonCacheable: cache.nonCacheable,
  };
}

// Which pages are in scope is DISCOVERED, not listed. #5791's first failure was
// a sibling page nobody remembered to update — usage-rate-limits.mdx carries a
// near-verbatim copy of the api-platform.mdx prose with no cross-reference — so
// a hardcoded list of four would reproduce that miss for the fifth page. Any
// page that quotes the anchor is publishing this contract and gets checked;
// BOOTSTRAP_CACHE_DOC_FILES stays as the floor so a known surface that loses
// its bullet still fails instead of quietly dropping out of scope.
// `pages` is injectable so the selection and floor-check are testable without
// writing fixture files into docs/. Default reads only what walk() just listed,
// so a page cannot vanish between listing and read.
function bootstrapCacheDocSources(pages = null) {
  const candidates = pages ?? Object.fromEntries(
    walk('docs').filter((f) => f.endsWith('.mdx')).map((file) => [file, read(file)]),
  );
  const docs = {};
  const failures = [];
  for (const [file, text] of Object.entries(candidates)) {
    if (text.includes(BOOTSTRAP_CACHE_ANCHOR)) docs[file] = text;
  }
  for (const file of BOOTSTRAP_CACHE_DOC_FILES) {
    if (docs[file]) continue;
    failures.push(`${file}: known /api/bootstrap cache surface no longer publishes the contract (missing ${BOOTSTRAP_CACHE_ANCHOR})`);
  }
  return { docs, failures };
}

// keyTiers is read here rather than carried in stats.json: it is validator
// input, like the i18n source above, and dumping all ~113 registry entries into
// the generated snapshot would bury the claims it actually publishes.
function validateBootstrapCacheDocs(stats, docs = null, keyTiers = parseBootstrapKeyTiers()) {
  const failures = [];
  if (docs === null) {
    const discovered = bootstrapCacheDocSources();
    failures.push(...discovered.failures);
    docs = discovered.docs;
  }
  const cache = stats.bootstrapCache;
  const expected = expectedBootstrapCacheDocValues(cache);

  for (const [file, text] of Object.entries(docs)) {
    // Page-wide: a hand-written "The <tier> tier includes `<key>`" sentence must
    // name the tier the key is actually registered under. `chinaDecisionSignals`
    // sat documented as slow-tier while it is an on-demand key, so `?tier=slow`
    // never returned it.
    for (const [, tier, key] of text.matchAll(/The (fast|slow|on-demand) tier includes `(\w+)`/g)) {
      const actual = keyTiers[key];
      if (!actual) {
        failures.push(`${file}: \`${key}\` is documented as a ${tier}-tier bootstrap key but is not a registered bootstrap cache key`);
      } else if (actual !== tier) {
        failures.push(`${file}: \`${key}\` is documented as ${tier}-tier, shared/bootstrap-tier-keys.js registers it as ${actual}`);
      }
    }

    // Exactly one bullet, so "which line did we check" is never a guess: two
    // anchors would let a stale copy of the prose satisfy the gate from the
    // wrong line, which is how usage-rate-limits.mdx drifted in the first place.
    const anchored = text.split('\n').filter((l) => l.includes(BOOTSTRAP_CACHE_ANCHOR));
    if (anchored.length !== 1) {
      failures.push(
        `${file}: expected exactly one /api/bootstrap cache bullet quoting ${BOOTSTRAP_CACHE_ANCHOR}, found ${anchored.length}`,
      );
      continue;
    }
    const [line] = anchored;

    for (const { re, what, slots } of BOOTSTRAP_CACHE_CHECKS) {
      const m = line.match(re);
      if (!m) {
        failures.push(`${file}: /api/bootstrap cache bullet does not state ${what} (pattern ${re})`);
        continue;
      }
      slots.forEach(([slot, label], i) => {
        if (m[i + 1] !== expected[slot]) {
          failures.push(`${file}: ${label} documented as \`${m[i + 1]}\`, api/bootstrap.js emits \`${expected[slot]}\``);
        }
      });
    }

    // Each on-demand key that declares its OWN profile publishes headers the
    // inherited-tier sentence above does not describe, so the bullet must name
    // it with its real values — otherwise "unless the key declares its own" is
    // an escape hatch no reader can resolve and no gate can check.
    //
    // Checked in BOTH directions against the set the bullet actually publishes.
    // Iterating only the code's profiles left the reverse case open: drop
    // ON_DEMAND_CACHE_PROFILES to `{}` and every page still naming a key as
    // having its own headers passes, now describing a profile that is gone.
    const documented = new Map(
      [...line.matchAll(/`(\w+)`[^`]*`(max-age=[^`]+)`[^`]*CDN[^`]*`(s-maxage=[^`]+)`/g)]
        .map(([, key, browser, cdn]) => [key, { browser, cdn }]),
    );
    for (const key of documented.keys()) {
      if (!cache.onDemandProfiles[key]) {
        failures.push(`${file}: the cache bullet publishes an own cache profile for \`${key}\`, but api/bootstrap.js declares none`);
      }
    }
    for (const [key, profile] of Object.entries(cache.onDemandProfiles)) {
      const published = documented.get(key);
      if (!published) {
        failures.push(`${file}: on-demand key \`${key}\` declares its own cache profile in api/bootstrap.js but the cache bullet does not publish it`);
        continue;
      }
      const wanted = [
        [published.browser, cacheDirective(profile.browser, 'max-age', `${key} browser profile`), 'browser Cache-Control'],
        [published.cdn, cacheDirective(profile.cdn, 's-maxage', `${key} cdn profile`), 'CDN-Cache-Control'],
      ];
      for (const [found, value, label] of wanted) {
        if (found !== value) {
          failures.push(`${file}: \`${key}\` ${label} documented as \`${found}\`, api/bootstrap.js emits \`${value}\``);
        }
      }
    }
  }

  return failures;
}

// The --check validator set. Exported and iterated rather than called as four
// separate lines in main() so the wiring is data a test can assert: every
// validator here is unit-tested against its own fixtures, but nothing caught a
// validator being dropped from the CLI — the whole suite stayed green while
// `--check` silently stopped running that gate.
const DOC_VALIDATORS = [
  validateIndexLanguageMetadata,
  validateSupportedLanguagesRegistry,
  validateMcpAppsDocs,
  validateBootstrapCacheDocs,
];

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

  for (const validate of DOC_VALIDATORS) failures.push(...validate(stats));

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
    if (c.min && typeof c.value !== 'number') {
      failures.push(`${c.file}: min claims must use numeric expected values — pattern ${c.re}`);
      continue;
    }
    const found = typeof c.value === 'number' ? Number(m[1]) : m[1];
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

export {
  computeStats,
  validateIndexLanguageMetadata,
  validateSupportedLanguagesRegistry,
  parseSupportedLanguages,
  parseJsonLdBlocks,
  sameStringSet,
  describeSetDelta,
  parseMcpAppsInventory,
  validateMcpAppsDocs,
  parseBootstrapCacheContract,
  parseBootstrapKeyTiers,
  validateBootstrapCacheDocs,
  bootstrapCacheDocSources,
  BOOTSTRAP_CACHE_DOC_FILES,
  DOC_VALIDATORS,
};

// Run only when executed directly (node scripts/docs-stats.mjs [--check]).
// Stays import-safe so tests can load the validators without triggering the
// filesystem scan / CI gate on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
