#!/usr/bin/env node
/**
 * docs-stats — derived inventory metrics plus fixed documentation contracts.
 *
 * --check mode recomputes every stat and asserts that each registered doc
 * contract still matches repository truth. Inventory artifacts are written
 * atomically by scripts/generate-inventory-facts.mjs.
 *
 * Volatile capability counts are build artifacts for runtime/product display,
 * not hand-edited acceptance criteria. CLAIMS below retains only fixed
 * compatibility contracts that are behaviorally exact.
 *
 * Stats are parsed from source text without executing TypeScript, loading its
 * import graph, or requiring installed packages. This keeps the generator
 * usable in dependency-free CI and container build stages.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSourceAttributionStats } from './source-attribution.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// #6702: tests that stage probe trees redirect the module at a throwaway
// copy (see withStatsRoot below) so a sibling test scanning the REAL repo
// can never observe the probe. null means the real ROOT.
let rootOverride = null;
const rootOf = () => rootOverride ?? ROOT;
const read = (p) => readFileSync(join(rootOf(), p), 'utf8');
const dirsIn = (p) =>
  readdirSync(join(rootOf(), p), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const filesIn = (p) =>
  readdirSync(join(rootOf(), p), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
const entriesIn = (p) => readdirSync(join(rootOf(), p), { withFileTypes: true }).map((e) => e.name);
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

function stripCommentsAndTemplates(source) {
  let output = '';
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (character === '/' && next === '/') {
        output += '  ';
        state = 'line-comment';
        index += 1;
      } else if (character === '/' && next === '*') {
        output += '  ';
        state = 'block-comment';
        index += 1;
      } else if (character === '`') {
        output += ' ';
        state = 'template';
      } else {
        output += character;
        if (character === "'") state = 'single-quote';
        if (character === '"') state = 'double-quote';
      }
      continue;
    }
    if (state === 'line-comment') {
      output += character === '\n' ? '\n' : ' ';
      if (character === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        output += '  ';
        state = 'code';
        index += 1;
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state === 'template') {
      output += character === '\n' ? '\n' : ' ';
      if (character === '\\') {
        if (next === '\n') output += '\n';
        else output += ' ';
        index += 1;
      } else if (character === '`') {
        state = 'code';
      }
      continue;
    }
    output += character;
    if (character === '\\') {
      output += next ?? '';
      index += 1;
    } else if (
      (state === 'single-quote' && character === "'")
      || (state === 'double-quote' && character === '"')
    ) {
      state = 'code';
    }
  }
  if (state === 'block-comment' || state === 'template' || state.endsWith('quote')) {
    throw new Error(`docs-stats: unterminated ${state} in LAYER_REGISTRY`);
  }
  return output;
}

function readCallArguments(source, argumentsStart) {
  const argumentsList = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let index = argumentsStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      current += character;
      if (character === '\\') {
        current += source[index + 1] ?? '';
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
    } else if ('([{'.includes(character)) {
      depth += 1;
      current += character;
    } else if (')]}'.includes(character)) {
      if (character === ')' && depth === 0) {
        argumentsList.push(current.trim());
        return { args: argumentsList, end: index };
      }
      depth -= 1;
      if (depth < 0) throw new Error('docs-stats: unbalanced LAYER_REGISTRY def() call');
      current += character;
    } else if (character === ',' && depth === 0) {
      argumentsList.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  throw new Error('docs-stats: unterminated LAYER_REGISTRY def() call');
}

function parseLayerRegistry(source) {
  const start = source.indexOf('export const LAYER_REGISTRY');
  const end = source.indexOf('export const V1_LAYER_EXPLANATION_KEYS', start);
  if (start === -1 || end === -1) {
    throw new Error('docs-stats: could not find the complete LAYER_REGISTRY block');
  }
  const registryBlock = stripCommentsAndTemplates(source.slice(start, end));
  let cursor = registryBlock.indexOf('{');
  if (cursor === -1) throw new Error('docs-stats: LAYER_REGISTRY must be an object literal');
  cursor += 1;
  const declaredKeys = [];
  const mismatchedKeys = [];
  const lockedKeys = [];
  while (cursor < registryBlock.length) {
    while (/\s|,/.test(registryBlock[cursor] ?? '')) cursor += 1;
    if (registryBlock[cursor] === '}') break;
    if (registryBlock.startsWith('...', cursor)) {
      throw new Error('docs-stats: LAYER_REGISTRY spread properties are not supported');
    }
    if (registryBlock[cursor] === '[') {
      throw new Error('docs-stats: LAYER_REGISTRY computed properties are not supported');
    }

    let key = '';
    const quote = registryBlock[cursor] === "'" || registryBlock[cursor] === '"'
      ? registryBlock[cursor]
      : null;
    if (quote) {
      cursor += 1;
      while (cursor < registryBlock.length && registryBlock[cursor] !== quote) {
        if (registryBlock[cursor] === '\\') {
          throw new Error('docs-stats: LAYER_REGISTRY property keys must not use escapes');
        }
        key += registryBlock[cursor];
        cursor += 1;
      }
      if (registryBlock[cursor] !== quote) {
        throw new Error('docs-stats: unterminated LAYER_REGISTRY property key');
      }
      cursor += 1;
    } else {
      const identifier = registryBlock.slice(cursor).match(/^[A-Za-z_$][\w$]*/)?.[0];
      if (!identifier) throw new Error('docs-stats: every LAYER_REGISTRY property must have a static key');
      key = identifier;
      cursor += identifier.length;
    }
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      throw new Error(`docs-stats: invalid LAYER_REGISTRY property key ${key}`);
    }
    while (/\s/.test(registryBlock[cursor] ?? '')) cursor += 1;
    if (registryBlock[cursor] !== ':') {
      throw new Error(`docs-stats: LAYER_REGISTRY property ${key} must be an assignment`);
    }
    cursor += 1;
    while (/\s/.test(registryBlock[cursor] ?? '')) cursor += 1;
    if (!registryBlock.startsWith('def(', cursor)) {
      throw new Error(`docs-stats: LAYER_REGISTRY property ${key} must use def()`);
    }
    const { args, end: callEnd } = readCallArguments(registryBlock, cursor + 4);
    cursor = callEnd + 1;
    declaredKeys.push(key);
    const definitionKey = args[0]?.match(/^(['"])([A-Za-z_$][\w$]*)\1$/)?.[2];
    if (!definitionKey) {
      throw new Error(`docs-stats: LAYER_REGISTRY property ${key} needs a static def() key`);
    }
    if (key !== definitionKey) mismatchedKeys.push(`${key} -> ${definitionKey}`);
    if (/^(['"])locked\1$/.test(args[5] ?? '')) lockedKeys.push(key);
  }
  if (declaredKeys.length === 0) {
    throw new Error('docs-stats: LAYER_REGISTRY extraction was empty');
  }
  if (new Set(declaredKeys).size !== declaredKeys.length) {
    throw new Error('docs-stats: LAYER_REGISTRY contains duplicate keys');
  }
  if (mismatchedKeys.length > 0) {
    throw new Error(
      `docs-stats: every LAYER_REGISTRY property must be a matching def('<key>', ...) call; mismatched: ${mismatchedKeys.join(', ')}`,
    );
  }
  return {
    keys: sorted(declaredKeys),
    lockedKeys: sorted(lockedKeys),
  };
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

  const successBlock = source.match(/function successCacheHeaders\([\s\S]*?\n\}/)?.[0];
  if (!successBlock) throw new Error('docs-stats: could not parse successCacheHeaders in api/bootstrap.js');

  // `const tier = requestedTier ?? (authKind === 'public-on-demand' ? 'slow' : null)`
  // — the tier a marked single-key on-demand URL inherits when it declares no
  // profile of its own. Read inside successCacheHeaders, where the default now
  // lives, for the same reason as the fallbacks below: bounded to the emitter so
  // a removed default throws instead of matching something unrelated.
  const onDemandDefaultTier = successBlock.match(
    /const tier = requestedTier \?\? \(authKind === 'public-on-demand' \? '(\w+)' : null\);/,
  )?.[1];
  if (!onDemandDefaultTier || !tierCache[onDemandDefaultTier]) {
    throw new Error('docs-stats: could not parse the public-on-demand default cache tier in api/bootstrap.js');
  }

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

  // Pin the WIRING, not just the constants. Parsing the on-demand default proves
  // the value is COMPUTED, never that it reaches the emitter; same for the
  // profile lookup, without which the per-key overrides are dead.
  //
  // The default used to be computed at the call site and passed in, so this
  // checked that the caller passed the computed value rather than the raw
  // `tier`. #6763 moved it inside successCacheHeaders — there is now one
  // resolution path and no call-site variant that can silently drop
  // inheritance — so what is pinned here is that the handler still routes its
  // success response through that emitter at all.
  //
  // A source gate cannot prove runtime behavior (api/bootstrap-auth.test.mjs
  // does that); this narrows the gap between "the constant says X" and "the
  // handler emits X" to a rename, which throws rather than passing quietly.
  if (!/successCacheHeaders\(\s*tier,\s*auth\.kind,\s*cors,\s*onDemandKey,?\s*\)/.test(source)) {
    throw new Error(
      'docs-stats: api/bootstrap.js no longer calls successCacheHeaders(tier, auth.kind, cors, onDemandKey) '
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
    // Drop `//` comments before scanning for quoted names. The quote matcher
    // cannot tell a key from prose, so one apostrophe in a rationale comment
    // ("the tab's list") opens a phantom string that swallows everything up to
    // the next apostrophe and registers it as a duplicate key — reported as
    // `key ", " is registered in both on-demand and on-demand tiers`, which
    // names neither the real cause nor the offending line. These Sets hold bare
    // string literals only, so there is no `//` inside a key to protect.
    const entries = block[1].replace(/\/\/[^\n]*/g, '');
    for (const m of entries.matchAll(/'([^']+)'/g)) {
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

// ---- /api/health probed-key registry (api/health.js) ----
//
// Four published example responses quote `summary.total`, which is the single
// number a reader uses to sanity-check whether their own response looks
// complete. #6300: all four sat at 194 while production reported 256 — a
// quarter of the fleet missing — and the figure had been copied forward often
// enough (two English pages, two zh mirrors, plus a PR body quoting them) that
// the agreement read as corroboration rather than as one stale number.
//
// Text-parsed rather than imported, like every other stat here: the docs-stats
// CI job runs on bare Node with no `npm install`, and the runtime registry size
// additionally depends on process.env.IRAN_EVENTS_ENABLED — an env-dependent
// number must not land in the build-owned docs/generated/stats.json.
//
// The two object literals are NOT the whole registry: health.js mutates them
// after declaration. Hardcoding that arithmetic is the same trap the docs fell
// into — it would keep reporting a confident number that silently drifts the
// moment a third mutation lands. So every mutation site is DISCOVERED and must
// be one this function accounts for; an unrecognized one fails the gate loudly
// instead of quietly publishing a wrong total.
const HEALTH_PROBED_REGISTRIES = ['BOOTSTRAP_KEYS', 'STANDALONE_KEYS'];

const HEALTH_REGISTRY_MUTATION_RE = new RegExp(
  [
    // `delete BOOTSTRAP_KEYS.iranEvents;`
    String.raw`delete\s+(?:BOOTSTRAP_KEYS|STANDALONE_KEYS)\s*[.[][^\n]*`,
    // `BOOTSTRAP_KEYS[name] = ...;` — including the compound forms (`??=`,
    // `||=`, `&&=`), which register a key just as effectively. The `[^=]` tail
    // keeps reads (`STANDALONE_KEYS[sibling] ?? …`) and `===` out of the match.
    String.raw`(?:BOOTSTRAP_KEYS|STANDALONE_KEYS)\s*(?:\[[^\]]*\]|\.\w+)\s*(?:\?\?|\|\||&&)?=[^=][^\n]*`,
    // `Object.assign(BOOTSTRAP_KEYS, …)` / `Object.defineProperty(…)`
    String.raw`Object\.(?:assign|defineProperty|defineProperties)\(\s*(?:BOOTSTRAP_KEYS|STANDALONE_KEYS)[^\n]*`,
    // Aliasing the registry to another binding — writes through the alias are
    // invisible to every pattern above, so the alias itself is the mutation
    // site to flag. `\s*[;,)]` keeps ordinary indexed reads
    // (`… ?? BOOTSTRAP_KEYS[sibling]`, followed by `[`) out of the match.
    String.raw`=\s*(?:BOOTSTRAP_KEYS|STANDALONE_KEYS)\s*[;,)][^\n]*`,
  ].join('|'),
  'g',
);

// Comments are blanked before the mutation scan and the registry-body parse.
// Two distinct silent failures come from reading them as code:
//   1. A commented-out `// delete BOOTSTRAP_KEYS.iranEvents;` normalizes to the
//      exact accounted string, satisfying the very presence check whose error
//      message is "stale arithmetic" while the runtime registry keeps the key.
//   2. `parseObjectBlockBody` counts raw braces, so one `}` inside a comment in
//      a registry literal ends the block early and yields a confident short
//      count rather than an error.
// Blanked in place (not deleted) so line and column offsets survive — the key
// matcher below keys on an exact two-space indent.
//
// LINE comments must go FIRST. api/health.js:793 contains the line comment
// `// list synchronized with consumer-prices-core/configs/retailers/*.yaml.`,
// whose `/*` opens a block comment that the block matcher then runs 1098 lines
// to the next `*/` to close — blanking the consumer-price loop, the iranEvents
// delete, and most of STANDALONE_KEYS along with it. Stripping line comments
// first removes that text before any `/*` is looked for.
//
// A `/*` inside a string or regex literal would still mislead the block pass;
// nothing in this file has one today, and the registry cross-count plus the
// runtime-pinning test both fail loudly if that ever changes.
const blankComments = (src) => src
  .replace(/^([ \t]*)\/\/[^\n]*$/gm, '$1')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

// Every mutation this function knows how to price, in `normalizeMutation` form
// (trimmed, inner whitespace collapsed). Adding a mutation to api/health.js
// means teaching this list what it does to the count — that is the point.
const HEALTH_REGISTRY_ACCOUNTED_MUTATIONS = [
  // +1 per consumer-price market other than `ae` (which keeps its historical
  // name in the BOOTSTRAP_KEYS literal).
  'BOOTSTRAP_KEYS[name] = `consumer-prices:coverage:${market}`;',
  // -1: the iran-events sunset drops the key unless IRAN_EVENTS_ENABLED=true,
  // which defaults to false — so the documented (production) registry omits it.
  'delete BOOTSTRAP_KEYS.iranEvents;',
];

const normalizeMutation = (line) => line.trim().replace(/\s+/g, ' ');

// Depth-1 entries of a registry object literal. parseObjectBlockBody preserves
// the original indentation, so a top-level key sits at exactly two spaces; a
// nested object's keys would sit at four or more and are correctly excluded.
function countRegistryEntries(source, name) {
  const body = parseObjectBlockBody(source, `const ${name}`, `${name} in api/health.js`);
  // The literal's closing brace sits at column 0, so a correctly bounded body
  // ends on a blank line. Anything else means the brace counter stopped early
  // on a brace inside a string, and the short count that follows would look
  // perfectly plausible.
  if (!/\n[ \t]*$/.test(body)) {
    throw new Error(`docs-stats: ${name} in api/health.js did not terminate at a top-level closing brace`);
  }
  const keys = [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]);
  if (keys.length === 0) throw new Error(`docs-stats: ${name} in api/health.js yielded no keys`);
  const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dupe) throw new Error(`docs-stats: ${name} in api/health.js declares "${dupe}" twice`);
  // Whole-body conformance check. The matcher above reads exactly ONE shape —
  // a bare identifier key at a two-space indent, one per line — and silently
  // ignores every other legal shape: a quoted key, a computed `[CONST]` key, a
  // `...SPREAD`, a key indented four spaces, a second key on the same line.
  // Each of those changes `Object.entries(registry)` without changing this
  // count, and `keys.length === 0` is far too weak an alarm for that.
  //
  // Both registries are uniformly flat today (every value is a string literal
  // or an identifier, one entry per line), so demanding that EVERY non-blank
  // line conform is a true invariant rather than a guess. A future entry shape
  // that breaks it gets an explicit "teach the counter" failure instead of a
  // quietly smaller number. Comments are already blanked by the caller.
  const nonConforming = body
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^ {2}[A-Za-z_$][\w$]*:\s*\S/.test(line));
  if (nonConforming.length) {
    throw new Error(
      `docs-stats: ${name} in api/health.js has ${nonConforming.length} entr${nonConforming.length === 1 ? 'y' : 'ies'} `
      + `this counter cannot read (it reads one identifier key per line at a two-space indent): `
      + `${nonConforming.map((l) => l.trim()).join(' | ')}`,
    );
  }
  // A second key sharing a conforming line still counts once. Every entry ends
  // in a trailing comma, so comparing comma count to key count catches it.
  const commas = (body.match(/,/g) || []).length;
  if (commas !== keys.length) {
    throw new Error(
      `docs-stats: ${name} in api/health.js has ${commas} entry terminators but ${keys.length} readable keys `
      + '— more than one entry on a line, or a value containing a comma.',
    );
  }
  return keys;
}

// summary.total is one entry per key in EVERY registry the endpoint's `sources`
// array walks — not per key in the two registries this function happens to
// price. Adding a third registry there is the single edit that reproduces #6300
// exactly: production grows while every gate stays pinned at the old number.
// So read the array rather than assume it.
function parseProbedRegistries(source) {
  const block = source.match(/const sources = \[([\s\S]*?)\n {2}\];/);
  if (!block) throw new Error('docs-stats: could not parse the `sources` registry array in api/health.js');
  const listed = [...block[1].matchAll(/\[\s*([A-Za-z_$][\w$]*)\s*,/g)].map((m) => m[1]);
  if (!sameStringSet(listed, HEALTH_PROBED_REGISTRIES)) {
    throw new Error(
      'docs-stats: api/health.js probes a different set of key registries than parseHealthProbedKeys prices '
      + `(${describeSetDelta(listed, HEALTH_PROBED_REGISTRIES)}) — summary.total cannot be derived.`,
    );
  }
  return listed;
}

function parseHealthProbedKeys(rawSource = read('api/health.js')) {
  const source = blankComments(rawSource);
  parseProbedRegistries(source);

  // The registry size equals summary.total only because the endpoint counts
  // every entry unconditionally. A `continue` or a variant/env gate inserted
  // ahead of the increment would shrink production's total while this parse —
  // and the unit test that pins it to `Object.keys(...).length` — stayed put.
  if (!/for \(const \[name, redisKey\] of Object\.entries\(registry\)\) \{\s*\n\s*totalChecks\+\+;/.test(source)) {
    throw new Error(
      'docs-stats: api/health.js no longer counts every registry entry unconditionally, '
      + 'so summary.total is no longer the registry size.',
    );
  }

  const found = [...source.matchAll(HEALTH_REGISTRY_MUTATION_RE)].map((m) => normalizeMutation(m[0]));
  const unaccounted = found.filter((m) => !HEALTH_REGISTRY_ACCOUNTED_MUTATIONS.includes(m));
  if (unaccounted.length) {
    throw new Error(
      'docs-stats: api/health.js mutates its key registries in a way parseHealthProbedKeys does not '
      + `account for, so summary.total cannot be derived: ${sorted(unaccounted).join(' | ')}. `
      + 'Teach HEALTH_REGISTRY_ACCOUNTED_MUTATIONS what it does to the count.',
    );
  }
  for (const expected of HEALTH_REGISTRY_ACCOUNTED_MUTATIONS) {
    if (!found.includes(expected)) {
      throw new Error(
        `docs-stats: api/health.js no longer contains the accounted-for mutation \`${expected}\` — `
        + 'summary.total would be derived from stale arithmetic.',
      );
    }
  }

  const bootstrapKeys = countRegistryEntries(source, 'BOOTSTRAP_KEYS');
  const standaloneKeys = countRegistryEntries(source, 'STANDALONE_KEYS');

  // +N: the consumer-price loop registers every market except `ae`.
  const marketsBlock = source.match(/const CONSUMER_PRICE_HEALTH_MARKETS = Object\.freeze\(\[([^\]]*)\]\)/);
  if (!marketsBlock) {
    throw new Error('docs-stats: could not parse CONSUMER_PRICE_HEALTH_MARKETS in api/health.js');
  }
  const markets = [...marketsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (!markets.includes('ae')) {
    throw new Error("docs-stats: CONSUMER_PRICE_HEALTH_MARKETS no longer contains 'ae', which the loop skips");
  }
  if (!/if \(market === 'ae'\) continue;/.test(source)) {
    throw new Error("docs-stats: the consumer-price health loop no longer skips 'ae'");
  }
  // Mirror of the iranEvents presence guard below. `BOOTSTRAP_KEYS[name] = …`
  // OVERWRITES a same-named literal entry at runtime (count unchanged) while
  // this parse would add one for it — so a market name also declared in the
  // literal over-counts by one, exactly as a missing iranEvents would
  // under-count by one.
  const addedNames = markets.filter((m) => m !== 'ae').map((m) => `consumerPricesCoverage${m.toUpperCase()}`);
  // Same overwrite semantics within the market list itself: a repeated market
  // assigns the same property twice at runtime (count unchanged) while a naive
  // `.length` here would add one per iteration.
  const repeated = addedNames.find((n, i) => addedNames.indexOf(n) !== i);
  if (repeated) {
    throw new Error(
      `docs-stats: CONSUMER_PRICE_HEALTH_MARKETS yields "${repeated}" more than once — `
      + 'the runtime registers it once while this count would add it per occurrence.',
    );
  }
  const collision = addedNames.find((name) => bootstrapKeys.includes(name));
  if (collision) {
    throw new Error(
      `docs-stats: BOOTSTRAP_KEYS already declares "${collision}", which the consumer-price loop also `
      + 'registers — the runtime overwrites it while this count would add it twice.',
    );
  }
  const addedMarkets = addedNames.length;

  // -1: iran-events is sunset unless IRAN_EVENTS_ENABLED=true (default false).
  // Asserting it is present in the literal keeps the subtraction from
  // double-counting a key that was already removed from the declaration.
  if (!bootstrapKeys.includes('iranEvents')) {
    throw new Error('docs-stats: BOOTSTRAP_KEYS no longer declares iranEvents, so the sunset delete subtracts twice');
  }
  if (!/const IRAN_EVENTS_ENABLED = .*\?\? 'false'/.test(source)) {
    throw new Error('docs-stats: IRAN_EVENTS_ENABLED no longer defaults to false — the documented registry size changed');
  }

  // The effective registries: the literal, plus the loop's markets, minus the
  // sunset key. Names — not just counts — so the unit test can compare SETS
  // against the imported runtime registries; two compensating errors (one real
  // key missed, one phantom invented) net to an identical count but not to an
  // identical set. computeStats stores only the counts: dumping 256 key names
  // into the committed stats.json would bury the claims it actually publishes.
  const effectiveBootstrap = [...bootstrapKeys, ...addedNames].filter((k) => k !== 'iranEvents');
  const bootstrap = bootstrapKeys.length + addedMarkets - 1;
  const standalone = standaloneKeys.length;
  if (effectiveBootstrap.length !== bootstrap) {
    throw new Error(`docs-stats: internal — bootstrap arithmetic (${bootstrap}) disagrees with its key list (${effectiveBootstrap.length})`);
  }
  return {
    bootstrap,
    standalone,
    total: bootstrap + standalone,
    bootstrapKeys: effectiveBootstrap,
    standaloneKeys,
  };
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

function readdirPresentSync(abs) {
  try {
    return readdirSync(abs, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }
}

function walk(rel, out = []) {
  for (const e of readdirPresentSync(join(rootOf(), rel))) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(child, out);
    else out.push(child);
  }
  return out;
}

// #6702: run a callback against a throwaway COPY of the repo tree. Probe
// tests use this so they never mutate (or transiently create paths inside)
// the real checkout a sibling test may be scanning concurrently.
export async function withStatsRoot(fn) {
  const { cpSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const sandbox = mkdtempSync(join(tmpdir(), 'wm-docs-stats-'));
  const previous = rootOverride;
  rootOverride = sandbox;
  try {
    // Full tree minus the heavy/vendor directories: computeStats reads a
    // wide surface (api/, docs/, src/, shared/, data/...), and a missing
    // file throws rather than counting as zero.
    const entries = readdirSync(ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'target') {
        continue;
      }
      try {
        cpSync(join(ROOT, entry.name), join(sandbox, entry.name), { recursive: true });
      } catch {
        // A path that cannot be copied (platform link, transient state): the
        // stat reports zero for whatever lived there, same as a repo
        // without it.
      }
    }
    return await fn(sandbox);
  } finally {
    rootOverride = previous;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// Local leftovers (empty `api/[domain]/v1` after a dirty checkout) are not
// endpoints. Git cannot track empty trees, so a readdir count that includes
// them writes a stats.json CI cannot reproduce.
function dirHasFiles(rel) {
  for (const e of readdirPresentSync(join(rootOf(), rel))) {
    if (e.name.startsWith('.')) continue;
    const child = `${rel}/${e.name}`;
    if (e.isFile()) return true;
    if (e.isDirectory() && dirHasFiles(child)) return true;
  }
  return false;
}

function computeStats() {
  const makefile = read('Makefile');
  const serverCard = parseJson('public/.well-known/mcp/server-card.json');
  const mcpApps = parseMcpAppsInventory();

  // ---- Map layers (src/config/map-layer-definitions.ts) ----
  const mld = read('src/config/map-layer-definitions.ts');
  const { keys: layerKeys, lockedKeys: lockedLayerKeys } = parseLayerRegistry(mld);
  const layerDefinitions = layerKeys.length;

  // Web-locked premium layers: literal 'locked' in the def() call. Desktop-only
  // locks use the `_desktop ? 'locked' : undefined` ternary and stay free on web,
  // so they are excluded — plan copy describes the web product.
  //
  // Deliberately NOT derived here: a "free layer count". `layerDefinitions -
  // lockedLayerKeys.length` overstates it, because a registry entry can also be
  // unreachable for everyone (`isSunsetLayer` drops iranAttacks unless
  // VITE_ENABLE_IRAN_ATTACKS=true; App.ts hides cyberThreats unless
  // VITE_ENABLE_CYBER_LAYER=true) and VARIANT_LAYER_ORDER means no single site
  // shows the whole registry. Plan copy therefore names the Pro-only layer
  // instead of quoting a free total — see validatePlanLayerEntitlementCopy.
  const lockedLayerDefinitions = lockedLayerKeys.length;

  const variantBlock = mld.slice(mld.indexOf('VARIANT_LAYER_ORDER'), mld.indexOf('export function getLayersForVariant'));
  const variantLayers = {};
  for (const m of variantBlock.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    variantLayers[m[1]] = (m[2].match(/'[^']+'/g) || []).length;
  }
  const variantCount = Object.keys(variantLayers).length;

  // ---- Root app directories used by AGENTS.md and CONTRIBUTING.md ----
  const componentTopLevelTsFiles = filesIn('src/components').filter((f) => f.endsWith('.ts')).length;
  const serviceTopLevelEntries = entriesIn('src/services').length;
  const apiEndpointEntries = readdirSync(join(rootOf(), 'api'), { withFileTypes: true }).filter((e) => {
    const f = e.name;
    if (f.startsWith('_') || f.startsWith('.')) return false;
    if (/\.test\./.test(f) || /\.d\.ts$/.test(f) || /\.json$/.test(f)) return false;
    if (e.isDirectory()) return dirHasFiles(`api/${f}`);
    return e.isFile();
  }).length;

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

  // ---- Source attribution inventory (scripts/server/api/src URL contracts) ----
  // Keep this separate from the feed-label count: one provider can expose
  // several feed URLs, while a structured endpoint may never appear in the
  // curated-feed registry. The attribution checker owns manifest coverage;
  // docs-stats pins the public count surfaces to the same live number.
  const sourceAttribution = buildSourceAttributionStats({ rootDir: rootOf() });

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

  // ---- CII Tier-1 countries (src/config/countries.ts) ----
  const countriesSource = read('src/config/countries.ts');
  const tier1Match = countriesSource.match(/export const TIER1_COUNTRIES[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!tier1Match) {
    throw new Error('docs-stats: could not find TIER1_COUNTRIES in src/config/countries.ts');
  }
  const tier1Countries = (tier1Match[1].match(/^\s+[A-Z]{2}:/gm) || []).length;

  // ---- CRI rankable universe (scripts/shared/sovereign-status.json) ----
  const sovereignStatus = parseJson('scripts/shared/sovereign-status.json');
  if (!Array.isArray(sovereignStatus?.entries) || sovereignStatus.entries.length === 0) {
    throw new Error('docs-stats: could not read entries from scripts/shared/sovereign-status.json');
  }
  const rankableUniverseCountries = sovereignStatus.entries.length;

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
    _generated: 'scripts/generate-inventory-facts.mjs — build artifact; do not commit',
    layerDefinitions,
    lockedLayerDefinitions,
    lockedLayerKeys,
    tier1Countries,
    rankableUniverseCountries,
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
    sourceAttribution,
    sourceAttributionHosts: sourceAttribution.activeHosts,
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
    // Counts only — see parseHealthProbedKeys on why the key names stay out.
    healthProbedKeys: (({ bootstrap, standalone, total }) => ({ bootstrap, standalone, total }))(
      parseHealthProbedKeys(),
    ),
  };
}

/**
 * Registered exact document claims.
 *
 * Extensible inventories deliberately do not appear here. Their composition
 * changes independently in parallel work, so hand-maintained prose totals
 * create conflict-prone, self-updating release chores. Inventory publication
 * is instead protected by the authoritative registry, generated artifacts,
 * and set/parity validators at their owning boundaries.
 *
 * Keep only facts that are not extensible inventory cardinalities. `value`
 * returns the expected value; `min:true` treats a published number as a real
 * product floor. The regex must capture group 1.
 */
function claims(s) {
  return [
    // The generator version is a toolchain compatibility contract, not an
    // inventory total. Its documented value must stay exact.
    { file: 'AGENTS.md', re: /requires buf \+ sebuf (v\d+\.\d+\.\d+) plugins/, value: s.sebufVersion },
    { file: 'CONTRIBUTING.md', re: /currently \*\*(v\d+\.\d+\.\d+)\*\*/, value: s.sebufVersion },
  ];
}

const ENGLISH_VOLATILE_INVENTORY_CLAIM_RE = /\b\d[\d,]*(?:\s*[–-]\s*\d[\d,]*)?(?:\+)?\s+(?:(?:MCP|OpenAPI|Vercel|Telegram|YouTube|OSINT|AI|other|live|curated|interactive|interchangeable|documented|registered|observed|monitored|supported|news|data source|data|intelligence|separate|local|edge|typed|specialized|dashboard|military|strategic|operational|associated|government|advisory|installable|public|proto-backed|positive-news|mapped|tracked)\s+)*(?:tools|feeds|sources|providers|services|streams|connectors|credentials|API handlers|API endpoints|endpoints|operations|functions|domains|specs|layers|map layers|panels|variants|languages|locales|airports|bases|theaters|ports|pipelines|waterways|chokepoints|cables|satellites|clusters|routes|data ?centers|datacenters|entities|webcams|cameras|news channels|channels|agent skills|agent recipes|skills|recipes)\b/i;
const ENGLISH_WORD_VOLATILE_INVENTORY_CLAIM_RE = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:MCP|OpenAPI|Vercel|Telegram|YouTube|OSINT|AI|other|live|curated|interchangeable|documented|registered|observed|monitored|supported|news|data|intelligence|separate|local|typed|specialized|dashboard|military|strategic|operational|associated|government|advisory|installable|public|proto-backed|positive-news|mapped|tracked)\s+)*(?:tools|feeds|sources|providers|services|streams|connectors|API handlers|API endpoints|endpoints|operations|functions|domains|specs|layers|map layers|panels|variants|languages|locales|airports|bases|theaters|ports|pipelines|waterways|chokepoints|cables|satellites|clusters|routes|webcams|cameras|news channels|channels|agent skills|agent recipes|skills|recipes)\b/i;
const ENGLISH_INTERCHANGEABLE_SURFACES_RE = /\b(?:\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+interchangeable\s+surfaces\b/i;
const HYPHENATED_VOLATILE_INVENTORY_CLAIM_RE = /(?:^|\s)\d[\d,]*(?:\+)?-(?:tool|feed|source|provider|service|stream|connector|endpoint|operation|function|domain|spec|layer|panel|variant|language|locale|airport|base|theater|port|pipeline|waterway|chokepoint|cable|satellite|cluster|route|webcam|camera|channel|skill|recipe)s?\b/i;
const LABEL_FIRST_VOLATILE_INVENTORY_CLAIM_RE = /\b(?:tools|feeds|sources|providers|services|streams|connectors|API handlers|API endpoints|endpoints|operations|functions|domains|specs|map layers|panels|languages|locales|airports|webcams|cameras|news channels|channels|agent skills|agent recipes|skills|recipes)\s*:\s*\d[\d,]*(?:\+)?\b/i;
const MARKDOWN_TABLE_VOLATILE_INVENTORY_CLAIM_RE = /\|\s*(?:(?:live|video|news|data|map|military|AI|strategic|undersea|intelligence|Telegram|prediction)\s+)*(?:tools|feeds|sources|providers|services|streams|connectors|API handlers|API endpoints|endpoints|operations|functions|domains|specs|layers|panels|variants|languages|locales|airports|bases|theaters|ports|pipelines|waterways|chokepoints|satellites|clusters|routes|datacenters|cameras|webcams|channels|events)(?:\s+(?:supported|monitored|mapped|tracked|available))?\s*\|\s*\d[\d,]*(?:\+)?(?=\s*(?:\([^|\n]*\)\s*)?\|)/i;
const CHINESE_VOLATILE_INVENTORY_CLAIM_RE = /(?:^|[^A-Za-z0-9])\d[\d,]*\s*(?:(?:\+|多|以上)\s*)?(?:个|项)?\s*(?:(?:实时|精选|已注册|已观察|监控|受监控|独立|上游|生成的|可安装|公开|智能体|Vercel|Edge|边缘|数据|新闻|API|OSINT|军事|战略|作战)\s*)*(?:数据源|信息源|新闻源|服务(?:领域)?|工具|技能|配方|提供商|处理器|操作|地图图层|数据图层|图层|面板|语言|区域设置|机场|基地(?:数据库)?|战区|戰區|港口|管道|水道|咽喉要道|海底电缆|卫星|衛星|集群|路线|路線|数据中心|实体|边缘函数|函数|频道|頻道)(?=$|[\s，。、；：）)】<])/i;
const JAPANESE_VOLATILE_INVENTORY_CLAIM_RE = /(?:^|[^A-Za-z0-9])\d[\d,]*\s*(?:\+|以上)?\s*(?:個|個の|つの|件の|項目の|の)?\s*(?:(?:MCP|OpenAPI|Vercel|Telegram|YouTube|OSINT|AI|ライブ|登録済み|監視対象|専門|ダッシュボード)\s*)*(?:ツール|フィード|データソース|情報源|プロバイダー|サービス|ストリーム|コネクター|APIハンドラー|APIエンドポイント|エンドポイント|オペレーション|関数|ドメイン|仕様|マップレイヤー|パネル|バリアント|言語|ロケール|空港|データセンター|ウェブカメラ|チャンネル|エージェントスキル|Edge Functions|ダッシュボード)(?=$|[\s、。；：）)】<をがはにでへとも]|から|まで|より)/i;
const POSTFIX_VOLATILE_INVENTORY_CLAIM_RE = /(?:Vercel\s+)?Edge Functions\s*[（(]\s*\d[\d,]*\s*(?:\+|以上)\s*[）)]/i;
export const VOLATILE_INVENTORY_CLAIM_RE = new RegExp(
  `(?:${ENGLISH_VOLATILE_INVENTORY_CLAIM_RE.source}|${ENGLISH_WORD_VOLATILE_INVENTORY_CLAIM_RE.source}|${ENGLISH_INTERCHANGEABLE_SURFACES_RE.source}|${HYPHENATED_VOLATILE_INVENTORY_CLAIM_RE.source}|${LABEL_FIRST_VOLATILE_INVENTORY_CLAIM_RE.source}|${MARKDOWN_TABLE_VOLATILE_INVENTORY_CLAIM_RE.source}|${CHINESE_VOLATILE_INVENTORY_CLAIM_RE.source}|${JAPANESE_VOLATILE_INVENTORY_CLAIM_RE.source}|${POSTFIX_VOLATILE_INVENTORY_CLAIM_RE.source})`,
  'i',
);

export const ACQUISITION_CLAIM_ROOTS = [
  'index.html',
  'README.md',
  'README.zh-CN.md',
  'README.ja-JP.md',
  'server.json',
  'cli',
  'docs',
  'public',
  'public/.well-known/ai-catalog.json',
  'public/.well-known/agent-skills',
  'public/api/llms.txt',
  'pro-test/src/locales',
  'pro-test/index.html',
  'pro-test/welcome.html',
  'blog-site/src/content/blog',
  'scripts/build-agent-skills-index.mjs',
];
const ACQUISITION_CLAIM_EXCLUDES = [
  'docs/audits/',
  'docs/api/',
  'docs/brainstorms/',
  'docs/archive/',
  'docs/changelog.mdx',
  'docs/zh/changelog.mdx',
  'docs/Docs_To_Review/',
  'docs/desktop-parity-matrix.md',
  'docs/generated/',
  'docs/internal/',
  'docs/ideation/',
  'docs/perf/',
  'docs/plans/',
  'docs/research/',
  'docs/railway-seed-consolidation-runbook.md',
  'docs/solutions/',
  'docs/source-attribution.mdx',
  'public/blog/',
  'public/pro/',
  'public/openapi',
];
const ACQUISITION_CLAIM_EXTENSIONS = /\.(?:astro|html|json|md|mdx|mjs|txt)$/;

function isCurrentAcquisitionClaimSurface(path) {
  return (
    ['index.html', 'README.md', 'README.zh-CN.md', 'README.ja-JP.md', 'server.json', 'cli/README.md',
      'pro-test/index.html', 'pro-test/welcome.html', 'scripts/build-agent-skills-index.mjs'].includes(path)
    || /^docs\/.+\.(?:md|mdx)$/.test(path)
    || /^public\/[^/]+\.(?:md|txt|json)$/.test(path)
    || /^public\/(?:[^/]+\/)*llms\.txt$/.test(path)
    || path === 'public/.well-known/ai-catalog.json'
    || /^public\/\.well-known\/agent-skills\/[^/]+\/SKILL\.md$/.test(path)
    || /^pro-test\/src\/locales\/[^/]+\.json$/.test(path)
    || /^blog-site\/src\/content\/blog\/[^/]+\.md$/.test(path)
  );
}

export function collectCurrentAcquisitionClaimFiles() {
  const files = new Set();
  const visit = (path) => {
    if (ACQUISITION_CLAIM_EXCLUDES.some((prefix) => path.startsWith(prefix))) return;
    const absolute = join(rootOf(), path);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      if (ACQUISITION_CLAIM_ROOTS.includes(path)) {
        throw new Error(`docs-stats: required acquisition claim root is missing: ${path}`);
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute)) visit(`${path}/${entry}`);
      return;
    }
    if (ACQUISITION_CLAIM_EXTENSIONS.test(path) && isCurrentAcquisitionClaimSurface(path)) {
      files.add(path);
    }
  };
  for (const path of ACQUISITION_CLAIM_ROOTS) visit(path);
  return [...files].sort();
}

export function retainedExactContractCoverageFailures(contracts, observedContracts) {
  return contracts
    .filter((contract) => !observedContracts.has(contract))
    .map((contract) => `${contract.path}: retained exact count contract is missing or changed: ${contract.text}`);
}

export function validateVolatileInventoryClaims() {
  const retainedExactContracts = [
    { path: 'docs/signal-intelligence.mdx', text: /(?:3\+ source types|6\+ sources\/hour)/ },
    { path: 'docs/ai-intelligence.mdx', text: /8\+ feeds in 2 hours/ },
    { path: 'docs/data-sources.mdx', text: /Natural disasters from 3 sources/ },
    { path: 'docs/zh/data-sources.mdx', text: /来自 3 个数据源的自然灾害/ },
    { path: 'docs/data-sources.mdx', text: /25 feed categories would have generated 25,000 edge invocations/ },
    { path: 'docs/tradingview-screener-integration.md', text: /41\/41 operations/ },
    { path: 'docs/api-versioning.mdx', text: /version 1 operation/ },
    { path: 'docs/architecture.mdx', text: /protoc-gen-openapiv3.*OpenAPI 3\.1\.0 specs/ },
    { path: 'docs/PRESS_KIT.md', text: /72 indicators, 21 active dimensions, 6 domains/ },
    { path: 'docs/documentation.mdx', text: /72 indicators across 21 active dimensions and 6 domains/ },
    { path: 'docs/features.mdx', text: /72 indicators across 21 active dimensions and 6 domains/ },
    { path: 'docs/overview.mdx', text: /72 indicators across 21 active dimensions and 6 domains/ },
    { path: 'public/llms-full.txt', text: /72 indicators across 21 active dimensions, 6 domains/ },
    { path: 'blog-site/src/content/blog/country-instability-index-methodology-explained.md', text: /72 indicators, 21 active dimensions, and 6 domains/ },
    { path: 'blog-site/src/content/blog/country-resilience-index-methodology-explained.md', text: /72 indicators across 21 active dimensions and 6 domains/ },
    { path: 'blog-site/src/content/blog/country-resilience-index-methodology-explained.md', text: /six domains/i },
    { path: 'blog-site/src/content/blog/country-risk-monitoring-workflow-for-analysts.md', text: /72 indicators, 21 active dimensions, and 6 domains/ },
    // Fixed resilience schema. tests/resilience-doc-parity.test.mts derives
    // these values from the scorer registry and validates this exact page.
    { path: 'docs/methodology/country-resilience-index.mdx', text: /196 countries using 72 indicators across 21 dimensions and 6 domains/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /pillars\[\].*six domains/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /72 indicators across 21 active dimensions and 6 domains.*3 pillars.*2 structurally-retired dimensions/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /196-country public rankable universe.*72 indicators across 21 active dimensions and 6 domains.*2 structurally-retired dimensions/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /organized into 6 domains/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /6 domains are regrouped into 3 pillars/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /average of 5 domains and 13 dimensions/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /5-domain \/ 13-dimension structure.*6 new recovery dimensions/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /six-domain weighted aggregate.*rollback path/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /five-domain flat structure.*six-domain structure.*six new dimensions.*three-pillar outer layer/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /Re-anchored release-gate bands.*6-domain formula's/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /The 6-domain formula lives alongside the pillar combine/ },
    { path: 'docs/methodology/country-resilience-index.mdx', text: /current registry contains 72 indicators across 21 active dimensions and 6 domains.*2 structurally-retired dimensions/ },
    // Fixed scoring limits, not extensible source inventories.
    { path: 'docs/methodology/news-digest-and-briefing.mdx', text: /Corroboration score is capped at five sources/ },
    { path: 'docs/methodology/news-credibility.mdx', text: /at five sources, with `20` points per source before the `0.20` weight/ },
    { path: 'docs/methodology/news-digest-and-briefing.mdx', text: /per entity-level source, capped at five sources/ },
    { path: 'docs/methodology/news-digest-and-briefing.mdx', text: /`critical-developing`.*\+5 sources/ },
    { path: 'docs/methodology/news-digest-and-briefing.mdx', text: /`high-event`.*\+5 sources/ },
    { path: 'docs/methodology/news-digest-and-briefing.mdx', text: /`sanctions-regulatory`.*\+5 sources/ },
    { path: 'docs/methodology/news-digest-and-briefing.mdx', text: /`med`.*\+5 sources/ },
    { path: 'docs/mcp-tools-reference.mdx', text: /current four feeds, 5 is a compatibility safety threshold/ },
    { path: 'docs/mcp-tools-reference.mdx', text: /across seven domains/ },
    { path: 'docs/mcp-tools-reference.mdx', text: /between two airports/ },
    { path: 'docs/webcam-layer.mdx', text: /up to 4 webcams simultaneously/ },
    { path: 'docs/webcam-layer.mdx', text: /more than 4 webcams are pinned/ },
    { path: 'docs/webcam-layer.mdx', text: /Maximum 4 webcams can be active/ },
    { path: 'docs/algorithms.mdx', text: /38\+ (?:associated )?military bases/ },
    { path: 'docs/algorithms.mdx', text: /five operational theaters/ },
    // Fixed scoring universe: tests/chokepoint-scenario-doc-parity.test.mjs
    // derives the exact registry membership and validates this methodology.
    { path: 'docs/methodology/chokepoints.mdx', text: /13 monitored waterways/ },
    { path: 'blog-site/src/content/blog/alerts-notification-channels-worldmonitor.md', text: /six channels/i },
    { path: 'blog-site/src/content/blog/aviation-intelligence-airports-airspace-flight-prices.md', text: /between any two airports/ },
    { path: 'blog-site/src/content/blog/build-supply-chain-early-warning-system-api.md', text: /Three signals, three endpoints/ },
    { path: 'blog-site/src/content/blog/free-geopolitical-data-apis-2026.md', text: /ingest ten feeds/ },
    { path: 'blog-site/src/content/blog/supply-chain-early-warning-dashboard-worldmonitor-api.md', text: /five panels/ },
    { path: 'pro-test/src/locales/ja.json', text: /25ダッシュボード/ },
    { path: 'pro-test/src/locales/ja.json', text: /紛争は1つのマップレイヤー/ },
  ];
  const failures = [];
  const observedRetainedContracts = new Set();
  const visit = (path) => {
    for (const [index, line] of read(path).split('\n').entries()) {
      if (/\btool errors\b/i.test(line)) continue;
      if (/\bTier \d+(?:[–-]\d+)? sources\b/i.test(line)) continue;
      const retained = retainedExactContracts.filter((entry) => entry.path === path && entry.text.test(line));
      if (retained.length > 0) {
        for (const contract of retained) observedRetainedContracts.add(contract);
        continue;
      }
      if (!VOLATILE_INVENTORY_CLAIM_RE.test(line)) continue;
      failures.push(`${path}:${index + 1}: hand-authored acquisition copy must use registry-derived or semantic inventory wording: ${line.trim()}`);
    }
  };
  for (const path of collectCurrentAcquisitionClaimFiles()) visit(path);
  failures.push(...retainedExactContractCoverageFailures(retainedExactContracts, observedRetainedContracts));
  return failures;
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

// ---- /api/health summary example bodies (#6300) ----
//
// `"onDemandWarn"` is the anchor: it is unique to this endpoint's summary
// object, and the double quotes keep it inside JSON examples rather than the
// surrounding prose, which names the same field in backticks.
const HEALTH_SUMMARY_ANCHOR = '"onDemandWarn"';

// The floor, for the same reason BOOTSTRAP_CACHE_DOC_FILES has one: scope is
// DISCOVERED so a sibling page nobody remembered gets checked too, but a known
// surface that loses its example must fail rather than drop quietly out of
// scope. Two of these four are zh mirrors — the pages #6300 shows are exactly
// the ones a hand-maintained list forgets.
const HEALTH_SUMMARY_DOC_FILES = [
  'docs/health-endpoints.mdx',
  'docs/api-platform.mdx',
  'docs/zh/health-endpoints.mdx',
  'docs/zh/api-platform.mdx',
];

function healthSummaryDocSources(pages = null) {
  const candidates = pages ?? Object.fromEntries(
    walk('docs').filter((f) => f.endsWith('.mdx')).map((file) => [file, read(file)]),
  );
  const docs = {};
  const failures = [];
  for (const [file, text] of Object.entries(candidates)) {
    if (text.includes(HEALTH_SUMMARY_ANCHOR)) docs[file] = text;
  }
  for (const file of HEALTH_SUMMARY_DOC_FILES) {
    if (docs[file]) continue;
    failures.push(
      `${file}: known /api/health surface no longer publishes a summary example (missing ${HEALTH_SUMMARY_ANCHOR})`,
    );
  }
  return { docs, failures };
}

// EVERY summary block on a publishing page is checked, not just the first.
// That is the whole reason this is a validator and not a claim: `claims()` uses
// `text.match()`, so appending a second example body below the pinned one would
// publish a number the gate never reads — reproducing #6300 on a docs-only PR,
// which also skips the `unit` job and so gets no other coverage at all.
//
// Two properties are asserted per block, and only two, so a page stays free to
// illustrate a WARNING fleet rather than only an all-OK one:
//   - `total` equals the registry size. True of any response, whatever its status.
//   - the buckets sum to `total`. `summary.warn` is already net of onDemandWarn
//     (api/health.js computes `realWarnCount = counts.warn - counts.onDemandWarn`),
//     and staleContent/rolloutPending are documented SUBSETS of warn, so the
//     partition is exactly ok + warn + onDemandWarn + crit. This is what caught
//     the pre-#6300 api-platform.mdx body, which showed a concrete "HEALTHY"
//     alongside 5 warns.
function validateHealthSummaryDocs(stats, docs = null) {
  const failures = [];
  if (docs === null) {
    const discovered = healthSummaryDocSources();
    failures.push(...discovered.failures);
    docs = discovered.docs;
  }
  const total = stats.healthProbedKeys.total;

  for (const [file, text] of Object.entries(docs)) {
    const blocks = [...text.matchAll(/"summary":\s*\{([^{}]*)\}/g)];
    if (blocks.length === 0) {
      failures.push(`${file}: publishes ${HEALTH_SUMMARY_ANCHOR} but no readable "summary" object`);
      continue;
    }
    blocks.forEach(([, body], i) => {
      const where = blocks.length > 1 ? `${file} (summary example ${i + 1} of ${blocks.length})` : file;
      const field = (name) => {
        const m = new RegExp(`"${name}":\\s*(\\d+)`).exec(body);
        return m ? Number(m[1]) : null;
      };
      const counts = {};
      for (const name of ['total', 'ok', 'warn', 'onDemandWarn', 'staleContent', 'rolloutPending', 'crit']) {
        counts[name] = field(name);
        if (counts[name] === null) failures.push(`${where}: /api/health summary example is missing "${name}"`);
      }
      if (Object.values(counts).some((v) => v === null)) return;

      if (counts.total !== total) {
        failures.push(`${where}: summary.total is ${counts.total}, but /api/health probes ${total} keys`);
      }
      const partition = counts.ok + counts.warn + counts.onDemandWarn + counts.crit;
      if (partition !== counts.total) {
        failures.push(
          `${where}: ok + warn + onDemandWarn + crit = ${partition}, which must equal total (${counts.total})`,
        );
      }
      for (const subset of ['staleContent', 'rolloutPending']) {
        if (counts[subset] > counts.warn) {
          failures.push(
            `${where}: ${subset} (${counts[subset]}) is documented as a subset of warn (${counts.warn})`,
          );
        }
      }
    });
  }
  return failures;
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

/**
 * Plan copy names the Pro-only map layer rather than quoting a free-layer count
 * (#5387). That phrasing is only true while `resilienceScore` is the ONLY
 * web-locked entry in LAYER_REGISTRY: lock a second layer and every surface
 * below silently starts over-promising again, exactly the way "all 56 map
 * layers" did. A count pin cannot catch that — the total does not move when a
 * layer flips to `premium: 'locked'` — so assert the identity of the locked set
 * and re-point the author at the copy that names it.
 */
export const PLAN_LAYER_COPY_SURFACES = [
  'public/pricing.md',
  'docs/pricing.mdx',
  'docs/accounts.mdx',
  'docs/zh/pricing.mdx',
  'docs/zh/accounts.mdx',
  'pro-test/src/locales/en.json',
  'pro-test/welcome.html',
  // The category explainer names the free-tier layer boundary too ("Every
  // layer except the Resilience layer is available on the free plan"), so it
  // has to be re-pointed alongside the pricing surfaces when the lock set moves.
  'blog-site/src/content/blog/what-is-worldmonitor-real-time-global-intelligence.md',
];

/** The single web-locked layer the copy above is written around. */
export const PLAN_LAYER_PRO_ONLY_KEY = 'resilienceScore';
const PLAN_LAYER_PRO_ONLY_LABEL = 'Resilience';

export function validatePlanLayerEntitlementCopy(stats, readFile = read) {
  const failures = [];
  const locked = stats.lockedLayerKeys ?? [];

  if (locked.join(',') !== PLAN_LAYER_PRO_ONLY_KEY) {
    failures.push(
      `src/config/map-layer-definitions.ts: plan copy names ${PLAN_LAYER_PRO_ONLY_LABEL} as the only Pro-only map layer, but LAYER_REGISTRY web-locks [${locked.join(', ')}] — update the free-tier copy in ${PLAN_LAYER_COPY_SURFACES.join(', ')} before changing the lock set`,
    );
    return failures;
  }

  for (const file of PLAN_LAYER_COPY_SURFACES) {
    let text;
    try {
      text = readFile(file);
    } catch {
      failures.push(`${file}: file not found`);
      continue;
    }
    if (!text.includes(PLAN_LAYER_PRO_ONLY_LABEL)) {
      failures.push(`${file}: free-tier copy must name the Pro-only "${PLAN_LAYER_PRO_ONLY_LABEL}" map layer (#5387)`);
    }
  }
  return failures;
}

/**
 * The category explainer's answer-first shape (#6217).
 *
 * The explainer is the site's primary "what is this product" page and is
 * written to be quoted verbatim by answer engines, so its shape is a contract:
 * a self-contained definition before any narrative, the variant count matching
 * the generated registry, the methodology/pricing links a citation needs, and
 * none of the stale claims the rewrite retired.
 *
 * This lives here rather than in tests/blog-seo-contract.test.mjs because that
 * file only runs in the `unit` job, which is gated on `changes.code == 'true'`
 * and whose filter drops every `.md` path — so the contract guarding a markdown
 * page did not run on the markdown-only PRs most likely to break it. The
 * docs-stats job is always-on for exactly this reason.
 *
 * Purely numeric facts belong in claims() above, not here; this covers only
 * what a "doc says N, code says N" pin cannot express.
 */
export const CATEGORY_EXPLAINER_PATH =
  'blog-site/src/content/blog/what-is-worldmonitor-real-time-global-intelligence.md';

const CATEGORY_EXPLAINER_OPENING =
  /^World Monitor is a \*\*free, open-source, real-time global intelligence dashboard\*\*/;
// Wide enough that ordinary copy edits pass; narrow enough that the definition
// cannot decay into a one-liner or swell back into the old narrative lede.
const CATEGORY_EXPLAINER_OPENING_WORDS = { min: 35, max: 80 };
const CATEGORY_EXPLAINER_REQUIRED_LINKS = [
  'https://www.worldmonitor.app/docs/data-sources',
  'https://www.worldmonitor.app/pricing.md',
  '/blog/glossary/',
];
// The paid tiers must stay named. The page previously claimed there was no
// tier above free at all, so silence here is the regression, not just an
// omission — an answer engine quoting it would tell readers Pro does not exist.
const CATEGORY_EXPLAINER_REQUIRED_COPY = [
  [/paid Pro, API, and Enterprise plans/i, 'the paid Pro/API/Enterprise tiers'],
];
// Claims the rewrite retired because the code had moved on. A revert or a
// copy-paste from an older post silently reintroduces them.
const CATEGORY_EXPLAINER_RETIRED_COPY = [
  [/Five Dashboards/, 'the retired five-variant count'],
  [/no "enterprise tier"/, 'the retired "no enterprise tier" claim'],
  [/React \+ TypeScript/, 'the retired React frontend stack (the web app uses Preact)'],
  [/baseline risk \(40%\)[\s\S]*?unrest indicators \(20%\)/, 'the retired CII weight breakdown'],
];

export function validateCategoryExplainerCopy(stats, readFile = read) {
  const file = CATEGORY_EXPLAINER_PATH;
  let text;
  try {
    text = readFile(file);
  } catch {
    return [`${file}: file not found`];
  }

  const frontmatter = text.match(/^---\n[\s\S]*?\n---\n/);
  if (!frontmatter) return [`${file}: missing frontmatter`];
  const body = text.slice(frontmatter[0].length);
  const failures = [];

  // Locate the opening by its first H2 rather than a line count, and fail
  // loudly when there is none — an indexOf(-1) slice would silently treat the
  // whole page as the "opening" and the word-count check would read as noise.
  const firstHeading = body.indexOf('\n## ');
  if (firstHeading === -1) {
    failures.push(`${file}: no H2 section, so the answer-first opening cannot be located`);
  } else {
    const opening = body.slice(0, firstHeading).trim();
    if (!CATEGORY_EXPLAINER_OPENING.test(opening)) {
      failures.push(`${file}: must open with the self-contained "World Monitor is a **free, open-source, real-time global intelligence dashboard**" definition`);
    }
    const words = opening.split(/\s+/).filter(Boolean).length;
    const { min, max } = CATEGORY_EXPLAINER_OPENING_WORDS;
    if (words < min || words > max) {
      failures.push(`${file}: answer-first opening is ${words} words, expected ${min}-${max}`);
    }
  }

  for (const link of CATEGORY_EXPLAINER_REQUIRED_LINKS) {
    if (!body.includes(link)) failures.push(`${file}: citation surface must link ${link}`);
  }
  for (const [pattern, what] of CATEGORY_EXPLAINER_REQUIRED_COPY) {
    if (!pattern.test(body)) failures.push(`${file}: must still name ${what}`);
  }
  for (const [pattern, what] of CATEGORY_EXPLAINER_RETIRED_COPY) {
    if (pattern.test(body)) failures.push(`${file}: reintroduces ${what}`);
  }
  const variantLine = body.match(/^- Dashboard variants \(registry keys\):\s*(.+)$/m)?.[1];
  if (!variantLine) {
    failures.push(`${file}: missing the enumerated dashboard-variant list`);
  } else {
    const documentedVariants = [...variantLine.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const expectedVariants = Object.keys(stats.variantLayers).sort();
    if (!sameStringSet(documentedVariants, expectedVariants)) {
      failures.push(
        `${file}: dashboard variants drift (${describeSetDelta(documentedVariants, expectedVariants)})`,
      );
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
  validateHealthSummaryDocs,
  validatePlanLayerEntitlementCopy,
  validateCategoryExplainerCopy,
  validateVolatileInventoryClaims,
];

function main() {
  const check = process.argv.includes('--check');
  const stats = computeStats();

  if (!check) {
    console.error('docs-stats only validates claims; run `npm run inventory:facts` to write generated stats.');
    process.exitCode = 1;
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
    console.error('\nFix the documented contract or its authoritative registry.');
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
  parseLayerRegistry,
  validateMcpAppsDocs,
  parseBootstrapCacheContract,
  parseBootstrapKeyTiers,
  parseHealthProbedKeys,
  parseProbedRegistries,
  validateHealthSummaryDocs,
  healthSummaryDocSources,
  HEALTH_SUMMARY_DOC_FILES,
  HEALTH_SUMMARY_ANCHOR,
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
