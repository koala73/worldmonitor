/**
 * The /api/bootstrap cache-header contract gate (#5794).
 *
 * `api/bootstrap-auth.test.mjs` already pins what the handler emits per auth
 * kind. What nothing pinned was the four doc surfaces that PUBLISH those
 * values, so during #5386/#5791 all four went wrong at once — in two different
 * ways — with every test green. These tests drive the gate's failure branches
 * with synthetic fixtures, so "the gate would have caught it" is executed
 * rather than asserted.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBootstrapCacheContract,
  parseBootstrapKeyTiers,
  validateBootstrapCacheDocs,
  bootstrapCacheDocSources,
  BOOTSTRAP_CACHE_DOC_FILES,
  DOC_VALIDATORS,
} from '../scripts/docs-stats.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const REAL_CACHE = parseBootstrapCacheContract();
const REAL_TIERS = parseBootstrapKeyTiers();
const REAL_STATS = { bootstrapCache: REAL_CACHE };
const REAL_DOCS: Record<string, string> = Object.fromEntries(
  BOOTSTRAP_CACHE_DOC_FILES.map((f: string) => [f, read(f)]),
);

const EN_PAGE = 'docs/api-platform.mdx';
const ZH_PAGE = 'docs/zh/api-platform.mdx';

/**
 * Mutate one published claim in a real doc page. Throws when the prose it
 * targets is gone: a fixture that silently stops mutating anything turns every
 * "this drift is caught" assertion below into a test of nothing.
 */
function mutate(file: string, from: string, to: string): Record<string, string> {
  const text = REAL_DOCS[file];
  const occurrences = text.split(from).length - 1;
  assert.equal(occurrences, 1, `fixture drift: ${file} must contain exactly one \`${from}\``);
  return { [file]: text.replace(from, to) };
}

const hit = (failures: string[], substr: string) => failures.some((f) => f.includes(substr));

const SYNTHETIC_BOOTSTRAP = `
const TIER_CACHE = {
  slow: 'max-age=300, stale-while-revalidate=600, stale-if-error=3600',
  fast: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
};
const TIER_CDN_CACHE = {
  slow: 'public, s-maxage=7200, stale-while-revalidate=1800, stale-if-error=7200',
  fast: 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
};
const ON_DEMAND_CACHE_PROFILES = {
  chinaDecisionSignals: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
  canadaRoads: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
  albertaRoads: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
  manitobaRoads: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
  bcOpen511: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=1800',
    cdn: 'public, s-maxage=1800, stale-while-revalidate=300, stale-if-error=1800',
  },
  marketCorrelationSeries: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
};
function successCacheHeaders(requestedTier, authKind, cors, onDemandKey = null) {
  const tier = requestedTier ?? (authKind === 'public-on-demand' ? 'slow' : null);
  if (!isPublicBootstrapKind(authKind)) {
    return { ...cors, 'Cache-Control': 'no-store' };
  }
  const publicCors = getPublicCorsHeaders();
  if (!isSharedCacheableBootstrapKind(authKind)) {
    return { ...publicCors, 'Cache-Control': 'no-store' };
  }
  const onDemandProfile = authKind === 'public-on-demand' ? ON_DEMAND_CACHE_PROFILES[onDemandKey] : null;
  const cacheControl = onDemandProfile?.browser
    || (tier && TIER_CACHE[tier])
    || 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900';
  return {
    ...publicCors,
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': onDemandProfile?.cdn
      || (tier && TIER_CDN_CACHE[tier])
      || TIER_CDN_CACHE.fast,
  };
}
const response = jsonResponse({ data, missing }, 200, successCacheHeaders(tier, auth.kind, cors, onDemandKey));
`;

describe('parseBootstrapCacheContract', () => {
  it('extracts every emitted value from a handler-shaped source', () => {
    const cache = parseBootstrapCacheContract(SYNTHETIC_BOOTSTRAP);
    assert.equal(cache.tierCache.fast, 'max-age=60, stale-while-revalidate=120, stale-if-error=900');
    assert.equal(cache.tierCache.slow, 'max-age=300, stale-while-revalidate=600, stale-if-error=3600');
    assert.equal(cache.tierCdnCache.fast, 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900');
    assert.equal(cache.tierCdnCache.slow, 'public, s-maxage=7200, stale-while-revalidate=1800, stale-if-error=7200');
    assert.equal(cache.onDemandDefaultTier, 'slow');
    assert.equal(cache.defaultCacheControl, 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900');
    assert.equal(cache.defaultCdnTier, 'fast');
    assert.equal(cache.nonCacheable, 'no-store');
    assert.deepEqual(cache.onDemandProfiles.chinaDecisionSignals, {
      browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
      cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
    });
  });

  it('parses the real api/bootstrap.js into a complete contract', () => {
    for (const tier of ['fast', 'slow']) {
      assert.match(REAL_CACHE.tierCache[tier], /^max-age=\d+,/);
      assert.match(REAL_CACHE.tierCdnCache[tier], /\bs-maxage=\d+\b/);
    }
    assert.ok(['fast', 'slow'].includes(REAL_CACHE.onDemandDefaultTier));
    assert.ok(['fast', 'slow'].includes(REAL_CACHE.defaultCdnTier));
    assert.equal(REAL_CACHE.nonCacheable, 'no-store');
    for (const [key, profile] of Object.entries(REAL_CACHE.onDemandProfiles)) {
      assert.match((profile as { browser: string }).browser, /\bmax-age=\d+\b/, key);
      assert.match((profile as { cdn: string }).cdn, /\bs-maxage=\d+\b/, key);
    }
  });

  // Fail-closed, the lesson LEADER_NAMES / PRIORITY_COUNTRIES already taught this
  // file: a parser that shrugs at a moved constant turns the gate into a no-op
  // that reports OK while checking nothing.
  it('throws when a cache constant is renamed or removed', () => {
    assert.throws(
      () => parseBootstrapCacheContract(SYNTHETIC_BOOTSTRAP.replace('const TIER_CDN_CACHE =', 'const CDN_CACHE =')),
      /could not parse TIER_CDN_CACHE/,
    );
  });

  it('throws when a tier loses its entry', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "  fast: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',\n};",
      '};',
    );
    assert.throws(() => parseBootstrapCacheContract(source), /TIER_CACHE .* is missing the fast tier/);
  });

  it('throws when an on-demand profile declares only half of its headers', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',\n",
      '',
    );
    assert.throws(() => parseBootstrapCacheContract(source), /must declare both browser and cdn/);
  });

  // The entry pattern is layout-sensitive and a miss returns {} rather than
  // throwing — which would silently switch off the per-key doc check while the
  // pages still publish those headers. Both reformats below parsed clean and
  // passed the gate before the cross-check landed.
  it('throws when the profile block is collapsed onto one line', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      / {2}chinaDecisionSignals: \{\n {4}browser: '([^']+)',\n {4}cdn: '([^']+)',\n {2}\},/,
      (_m: string, browser: string, cdn: string) => `  chinaDecisionSignals: { browser: '${browser}', cdn: '${cdn}' },`,
    );
    assert.notEqual(source, SYNTHETIC_BOOTSTRAP, 'fixture drift: profile block shape changed');
    assert.throws(() => parseBootstrapCacheContract(source), /the profile block layout changed/);
  });

  it('throws when the profile block is re-indented', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace('  chinaDecisionSignals: {', '    chinaDecisionSignals: {');
    assert.throws(() => parseBootstrapCacheContract(source), /the profile block layout changed/);
  });

  it('accepts a genuinely empty profile block', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      /const ON_DEMAND_CACHE_PROFILES = \{[\s\S]*?\n\};/,
      'const ON_DEMAND_CACHE_PROFILES = {};',
    );
    assert.deepEqual(parseBootstrapCacheContract(source).onDemandProfiles, {});
  });

  it('throws when the on-demand default tier moves', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "const tier = requestedTier ?? (authKind === 'public-on-demand' ? 'slow' : null);",
      'const tier = requestedTier ?? null;',
    );
    assert.notEqual(source, SYNTHETIC_BOOTSTRAP, 'fixture drift: on-demand default not found');
    assert.throws(() => parseBootstrapCacheContract(source), /public-on-demand default cache tier/);
  });

  it('throws when the on-demand default names a tier that does not exist', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace("? 'slow' : null)", "? 'medium' : null)");
    assert.notEqual(source, SYNTHETIC_BOOTSTRAP, 'fixture drift: on-demand default ternary not found');
    assert.throws(() => parseBootstrapCacheContract(source), /public-on-demand default cache tier/);
  });

  // Removing the tier-less default is what `?keys=weatherAlerts&public=1`
  // actually depends on. The lookup is bounded to successCacheHeaders, so this
  // throws rather than matching some unrelated `|| '...'` later in the module
  // and reporting a confident wrong value.
  it('throws when the tier-less browser fallback is removed', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "    || (tier && TIER_CACHE[tier])\n    || 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900';",
      '    || (tier && TIER_CACHE[tier]);',
    );
    assert.notEqual(source, SYNTHETIC_BOOTSTRAP, 'fixture drift: cacheControl fallback chain not found');
    assert.throws(() => parseBootstrapCacheContract(source), /tier-less public cache fallbacks/);
  });

  it('throws when the tier-less CDN fallback is removed', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      '      || (tier && TIER_CDN_CACHE[tier])\n      || TIER_CDN_CACHE.fast,',
      '      || (tier && TIER_CDN_CACHE[tier]),',
    );
    assert.notEqual(source, SYNTHETIC_BOOTSTRAP, 'fixture drift: CDN fallback chain not found');
    assert.throws(() => parseBootstrapCacheContract(source), /tier-less public cache fallbacks/);
  });

  it('throws when successCacheHeaders is renamed away', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace('function successCacheHeaders(', 'function buildCacheHeaders(');
    assert.throws(() => parseBootstrapCacheContract(source), /could not parse successCacheHeaders|no longer calls successCacheHeaders/);
  });

  it('throws on an unterminated object block instead of scanning to EOF', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace('const TIER_CACHE = {', 'const TIER_CACHE = { {');
    assert.throws(() => parseBootstrapCacheContract(source), /unbalanced braces/);
  });

  it('throws when successCacheHeaders grows an undocumented literal state', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "return { ...cors, 'Cache-Control': 'no-store' };",
      "return { ...cors, 'Cache-Control': 'private, max-age=0' };",
    );
    assert.throws(() => parseBootstrapCacheContract(source), /expected one/);
  });

  // Parsing a constant proves it is COMPUTED, never that it reaches the
  // emitter. Both mutations below leave every parsed value byte-identical
  // while the handler stops emitting what all four pages publish.
  // Was: swapping the computed `cacheTier` for the raw `tier` at the call site.
  // #6763 moved the on-demand default INSIDE successCacheHeaders, so passing the
  // raw tier is now the correct call and that mutation is no longer a defect —
  // there is one resolution path and no call-site variant that can drop
  // inheritance. What still has to bite is the handler routing its success
  // response somewhere other than the emitter, so mutate the argument the
  // emitter needs instead.
  it('throws when the emitter stops receiving the requested tier', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      'successCacheHeaders(tier, auth.kind, cors, onDemandKey)',
      'successCacheHeaders(null, auth.kind, cors, onDemandKey)',
    );
    assert.notEqual(source, SYNTHETIC_BOOTSTRAP, 'fixture drift: call site not found');
    assert.throws(() => parseBootstrapCacheContract(source), /no longer calls successCacheHeaders/);
  });

  it('throws when the emitter stops consulting the on-demand profiles', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace('? ON_DEMAND_CACHE_PROFILES[onDemandKey]', '? null');
    assert.notEqual(source, SYNTHETIC_BOOTSTRAP, 'fixture drift: profile lookup not found');
    assert.throws(() => parseBootstrapCacheContract(source), /no longer looks up ON_DEMAND_CACHE_PROFILES/);
  });

  // Deleting the second no-store branch is #5386 restored: the anonymous
  // weather URL becomes shared-cacheable. Deduping to a set left ['no-store']
  // and passed, so count branches.
  it('throws when a non-cacheable branch is deleted', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "  if (!isSharedCacheableBootstrapKind(authKind)) {\n    return { ...publicCors, 'Cache-Control': 'no-store' };\n  }\n",
      '',
    );
    assert.notEqual(source, SYNTHETIC_BOOTSTRAP, 'fixture drift: shared-cacheable branch not found');
    assert.throws(() => parseBootstrapCacheContract(source), /literal Cache-Control branches, expected 2/);
  });

  // The pages promise these shapes emit no CDN cache headers; nothing checked it.
  it('throws when a non-cacheable branch starts setting CDN-Cache-Control', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "return { ...cors, 'Cache-Control': 'no-store' };",
      "return { ...cors, 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store' };",
    );
    assert.throws(() => parseBootstrapCacheContract(source), /sets CDN-Cache-Control/);
  });
});

describe('parseBootstrapKeyTiers', () => {
  it('assigns each registered key to exactly one tier', () => {
    assert.equal(REAL_TIERS.chinaDecisionSignals, 'on-demand');
    assert.equal(REAL_TIERS.weatherAlerts, 'fast');
    assert.ok(Object.values(REAL_TIERS).every((t) => ['fast', 'slow', 'on-demand'].includes(t as string)));
  });

  it('throws when a tier set is renamed', () => {
    assert.throws(
      () => parseBootstrapKeyTiers("const OTHER = new Set([\n  'a',\n]);"),
      /could not parse FAST_KEY_NAMES/,
    );
  });

  it('throws when every tier set parses empty', () => {
    const empty = ['FAST_KEY_NAMES', 'SLOW_KEY_NAMES', 'ON_DEMAND_KEY_NAMES']
      .map((name) => `const ${name} = new Set([\n]);`).join('\n');
    assert.throws(() => parseBootstrapKeyTiers(empty), /yielded no key tier assignments/);
  });

  // Last-write-wins made this parser disagree with the runtime in the only case
  // that matters: tierForKey() tests fast first, so a key in FAST and ON_DEMAND
  // resolves to fast at runtime and resolved to on-demand here.
  it('throws when a key is registered in two tiers', () => {
    const source = read('shared/bootstrap-tier-keys.js')
      .replace("  'earthquakes', 'outages',", "  'earthquakes', 'outages', 'chinaDecisionSignals',");
    assert.notEqual(source, read('shared/bootstrap-tier-keys.js'), 'fixture drift: FAST_KEY_NAMES head changed');
    assert.throws(() => parseBootstrapKeyTiers(source), /registered in both fast and on-demand tiers/);
  });

  // An apostrophe in a rationale comment used to open a phantom string that ran
  // to the next apostrophe and registered as a duplicate key, failing with
  // `key ", " is registered in both on-demand and on-demand tiers` — a message
  // naming neither the cause nor the line. Comments are stripped before the
  // quote scan; this keeps prose safe to write next to the key list.
  it('ignores quotes inside comments in a tier block', () => {
    const source = read('shared/bootstrap-tier-keys.js')
      .replace(
        "const ON_DEMAND_KEY_NAMES = new Set([",
        "const ON_DEMAND_KEY_NAMES = new Set([\n  // the tab's list, which BIS cannot supply; it's on-demand",
      );
    assert.notEqual(source, read('shared/bootstrap-tier-keys.js'), 'fixture drift: ON_DEMAND_KEY_NAMES head changed');
    const tiers = parseBootstrapKeyTiers(source);
    assert.equal(tiers.cbrRates, 'on-demand', 'real keys still parse');
    for (const name of Object.keys(tiers)) {
      assert.match(name, /^[A-Za-z][A-Za-z0-9]*$/, `parsed a non-identifier key: ${JSON.stringify(name)}`);
    }
  });
});

describe('--check wiring', () => {
  // Every validator is unit-tested against its own fixtures, but nothing caught
  // a validator being dropped from the CLI: the whole suite stayed green while
  // `--check` silently stopped running that gate. DOC_VALIDATORS is the wiring,
  // so assert against it directly.
  it('runs the bootstrap cache gate as part of --check', () => {
    assert.ok(DOC_VALIDATORS.includes(validateBootstrapCacheDocs));
  });

  it('exits 0 end to end on the real repo', () => {
    const result = spawnSync('node', ['scripts/docs-stats.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /doc claims match code/);
  });
});

describe('bootstrapCacheDocSources', () => {
  it('discovers exactly the known surfaces by scanning docs/, not a hardcoded list', () => {
    const { docs, failures } = bootstrapCacheDocSources();
    assert.deepEqual(failures, []);
    assert.deepEqual(Object.keys(docs).sort(), [...BOOTSTRAP_CACHE_DOC_FILES].sort());
  });

  // The floor check is the whole reason this function exists, and every other
  // failure-path test passes an explicit docs map — which bypasses discovery
  // entirely. Without this, the safety net added for #5791's "sibling page
  // nobody remembered" class had nothing proving it ever fires.
  it('fails when a known surface stops publishing the contract', () => {
    const pages = Object.fromEntries(
      BOOTSTRAP_CACHE_DOC_FILES.map((f: string) => [f, REAL_DOCS[f]]),
    );
    pages['docs/usage-rate-limits.mdx'] = 'a page with no cache bullet at all';
    const { docs, failures } = bootstrapCacheDocSources(pages);
    assert.equal(Object.keys(docs).length, BOOTSTRAP_CACHE_DOC_FILES.length - 1);
    assert.equal(failures.length, 1);
    assert.ok(hit(failures, 'docs/usage-rate-limits.mdx: known /api/bootstrap cache surface no longer publishes the contract'));
  });

  // Discovery, not the list, is what puts a page in scope.
  it('pulls in an unlisted page that starts publishing the contract', () => {
    const pages = Object.fromEntries(
      BOOTSTRAP_CACHE_DOC_FILES.map((f: string) => [f, REAL_DOCS[f]]),
    );
    pages['docs/brand-new-surface.mdx'] = REAL_DOCS[EN_PAGE];
    const { docs, failures } = bootstrapCacheDocSources(pages);
    assert.deepEqual(failures, []);
    assert.ok(Object.keys(docs).includes('docs/brand-new-surface.mdx'));
  });

  it('ignores pages that never quote the contract', () => {
    const pages = Object.fromEntries(
      BOOTSTRAP_CACHE_DOC_FILES.map((f: string) => [f, REAL_DOCS[f]]),
    );
    pages['docs/unrelated.mdx'] = '# Something else entirely\n\nNo cache prose here.';
    const { docs } = bootstrapCacheDocSources(pages);
    assert.equal(Object.keys(docs).includes('docs/unrelated.mdx'), false);
  });
});

describe('validateBootstrapCacheDocs', () => {
  it('passes against the four real doc surfaces', () => {
    assert.deepEqual(validateBootstrapCacheDocs(REAL_STATS), []);
  });

  // A fifth page that starts publishing the contract must be checked like the
  // four we already know about — the validator is list-agnostic, and
  // bootstrapCacheDocSources finds the page by its content.
  it('checks a page outside the known list once it publishes the contract', () => {
    const stale = REAL_DOCS[EN_PAGE].replace('CDN `s-maxage=600` / `s-maxage=7200`', 'CDN `s-maxage=60` / `s-maxage=7200`');
    assert.notEqual(stale, REAL_DOCS[EN_PAGE], 'fixture drift: CDN tier values not found');
    const failures = validateBootstrapCacheDocs(REAL_STATS, { 'docs/some-new-page.mdx': stale });
    assert.ok(hit(failures, 'docs/some-new-page.mdx'));
    assert.ok(hit(failures, '?tier=fast&public=1 CDN-Cache-Control documented as `s-maxage=60`'));
  });

  // #5791, failure 1: docs/usage-rate-limits.mdx and its zh mirror carry a
  // near-verbatim copy of the api-platform.mdx cache prose with no
  // cross-reference, so "I updated the cache docs" was true of one file and
  // false of another. The gate must fail per-surface, not once for the set.
  it('catches a sibling page left behind when only one copy is updated', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate('docs/usage-rate-limits.mdx', 'browser `max-age=60` / `max-age=300`', 'browser `max-age=30` / `max-age=300`'),
    );
    assert.ok(hit(failures, 'docs/usage-rate-limits.mdx'));
    assert.ok(hit(failures, '?tier=fast&public=1 browser Cache-Control documented as `max-age=30`'));
  });

  // #5791, failure 2: the replacement prose claimed single-key
  // `?keys=<name>&public=1` URLs use `public, s-maxage=600`. Wrong for on-demand
  // keys — cacheTier falls back to 'slow', so they get browser `max-age=300`
  // and CDN `s-maxage=7200`.
  it('catches the on-demand single-key profile being described as the weather default', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(
        EN_PAGE,
        'inherit the slow profile — browser `max-age=300`, CDN `s-maxage=7200`',
        'inherit the fast profile — browser `max-age=60`, CDN `s-maxage=600`',
      ),
    );
    assert.ok(hit(failures, 'tier inherited by ?keys=<onDemandName>&public=1 documented as `fast`'));
    assert.ok(hit(failures, '?keys=<onDemandName>&public=1 browser Cache-Control documented as `max-age=60`'));
    assert.ok(hit(failures, '?keys=<onDemandName>&public=1 CDN-Cache-Control documented as `s-maxage=600`'));
  });

  // The check must be POSITIONAL. `s-maxage=600` is both the fast tier's CDN
  // value and part of the weatherAlerts header, so a page-wide substring search
  // stays green with the tiers transposed — green while dead.
  it('catches the fast and slow CDN values being transposed', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(EN_PAGE, 'CDN `s-maxage=600` / `s-maxage=7200`', 'CDN `s-maxage=7200` / `s-maxage=600`'),
    );
    assert.ok(hit(failures, '?tier=fast&public=1 CDN-Cache-Control documented as `s-maxage=7200`'));
    assert.ok(hit(failures, '?tier=slow&public=1 CDN-Cache-Control documented as `s-maxage=600`'));
  });

  it('catches a stale weatherAlerts header string', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(
        EN_PAGE,
        '`Cache-Control: public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900` with the fast-tier',
        '`Cache-Control: public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900` with the fast-tier',
      ),
    );
    assert.ok(hit(failures, '?keys=weatherAlerts&public=1 Cache-Control documented as'));
    assert.ok(hit(failures, 's-maxage=900'));
  });

  it('catches the credentialed shapes being described as cacheable', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(EN_PAGE, 'path — uses `Cache-Control: no-store`', 'path — uses `Cache-Control: public, s-maxage=60`'),
    );
    assert.ok(hit(failures, 'Cache-Control for every non-shared-cacheable shape documented as `public, s-maxage=60`'));
  });

  it('catches a zh mirror that drifts from the handler', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(ZH_PAGE, '浏览器 `max-age=60` / `max-age=300`', '浏览器 `max-age=60` / `max-age=600`'),
    );
    assert.ok(hit(failures, 'docs/zh/api-platform.mdx'));
    assert.ok(hit(failures, '?tier=slow&public=1 browser Cache-Control documented as `max-age=600`'));
  });

  // Drift from the code side: the docs stand still while api/bootstrap.js moves.
  it('catches a handler-side tier change the docs never followed', () => {
    const drifted = parseBootstrapCacheContract(
      SYNTHETIC_BOOTSTRAP.replace("fast: 'max-age=60,", "fast: 'max-age=120,"),
    );
    const failures = validateBootstrapCacheDocs(
      { bootstrapCache: drifted },
      REAL_DOCS,
      REAL_TIERS,
    );
    assert.equal(failures.length, BOOTSTRAP_CACHE_DOC_FILES.length);
    for (const file of BOOTSTRAP_CACHE_DOC_FILES) {
      assert.ok(hit(failures, `${file}: ?tier=fast&public=1 browser Cache-Control documented as \`max-age=60\`, api/bootstrap.js emits \`max-age=120\``));
    }
  });

  // "unless the key declares its own" is only honest while every declaring key
  // is published. A new profile must not be able to land silently.
  it('catches a newly declared on-demand profile that no page publishes', () => {
    const cache = {
      ...REAL_CACHE,
      onDemandProfiles: {
        ...REAL_CACHE.onDemandProfiles,
        portwatchPortActivity: { browser: 'max-age=30', cdn: 'public, s-maxage=1200' },
      },
    };
    const failures = validateBootstrapCacheDocs({ bootstrapCache: cache }, REAL_DOCS, REAL_TIERS);
    assert.equal(failures.length, BOOTSTRAP_CACHE_DOC_FILES.length);
    assert.ok(hit(failures, '`portwatchPortActivity` declares its own cache profile'));
  });

  // The reverse direction. Iterating only the code's profiles left this open:
  // remove the profile and every page still naming the key as having its own
  // headers passes, publishing a profile that no longer exists.
  it('catches a page publishing an own-profile that api/bootstrap.js no longer declares', () => {
    const cache = { ...REAL_CACHE, onDemandProfiles: {} };
    const failures = validateBootstrapCacheDocs({ bootstrapCache: cache }, REAL_DOCS, REAL_TIERS);
    // One failure per documented profile per page, derived rather than pinned at
    // one file each: #6763 took the published set from one key to five, and a
    // hardcoded count would have had to be re-guessed instead of following it.
    assert.equal(
      failures.length,
      BOOTSTRAP_CACHE_DOC_FILES.length * Object.keys(REAL_CACHE.onDemandProfiles).length,
    );
    assert.ok(hit(failures, 'publishes an own cache profile for `chinaDecisionSignals`, but api/bootstrap.js declares none'));
  });

  // Every other doc fixture swaps a captured VALUE, so the "anchor present but
  // the clause is structurally gone" branch — a reworded bullet that stops
  // stating a claim at all — was never exercised. That is the failure mode a
  // doc rewrite actually produces.
  for (const [label, from, to, expected] of [
    ['the tier pair', 'and CDN `s-maxage=600` / `s-maxage=7200`', 'and shielded at `s-maxage=600` / `s-maxage=7200`', 'the ?tier=fast|slow&public=1 browser/CDN values'],
    ['the on-demand clause', 'CDN `s-maxage=7200` — unless', 'shield `s-maxage=7200` — unless', 'the inherited on-demand single-key profile'],
    ['the weatherAlerts clause', 'with the fast-tier CDN shield', 'with the fast-tier shield', 'the ?keys=weatherAlerts&public=1 values'],
    ['the non-cacheable clause', 'path — uses `Cache-Control: no-store`', 'path — is never stored', 'the non-shared-cacheable value'],
  ] as [string, string, string, string][]) {
    it(`catches ${label} being reworded out of the bullet`, () => {
      const failures = validateBootstrapCacheDocs(REAL_STATS, mutate(EN_PAGE, from, to));
      assert.ok(hit(failures, `cache bullet does not state ${expected}`), failures.join(' | '));
    });
  }

  it('catches a declared on-demand profile whose published values are stale', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(EN_PAGE, '`chinaDecisionSignals` (browser `max-age=60`, CDN `s-maxage=900`)', '`chinaDecisionSignals` (browser `max-age=60`, CDN `s-maxage=7200`)'),
    );
    assert.ok(hit(failures, '`chinaDecisionSignals` CDN-Cache-Control documented as `s-maxage=7200`'));
  });

  // `?tier=slow` never returned chinaDecisionSignals — it is an on-demand key —
  // yet api-platform.mdx said it did.
  it('catches a key documented under a tier it is not registered in', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(EN_PAGE, 'The on-demand tier includes `chinaDecisionSignals`', 'The slow tier includes `chinaDecisionSignals`'),
    );
    assert.ok(hit(failures, '`chinaDecisionSignals` is documented as slow-tier'));
    assert.ok(hit(failures, 'registers it as on-demand'));
  });

  it('catches a tier sentence naming a key that is not a bootstrap key at all', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(EN_PAGE, 'The on-demand tier includes `chinaDecisionSignals`', 'The on-demand tier includes `chinaDecisionSignalz`'),
    );
    assert.ok(hit(failures, 'is not a registered bootstrap cache key'));
  });

  it('fails closed when the cache bullet is deleted outright', () => {
    const text = REAL_DOCS[EN_PAGE];
    const line = text.split('\n').find((l) => l.includes('`?tier=fast&public=1` / `?tier=slow&public=1`'))!;
    const failures = validateBootstrapCacheDocs(REAL_STATS, { [EN_PAGE]: text.replace(line, '') });
    assert.ok(hit(failures, 'expected exactly one /api/bootstrap cache bullet'));
    assert.ok(hit(failures, 'found 0'));
  });

  it('fails closed when a second copy of the bullet appears', () => {
    const text = REAL_DOCS[EN_PAGE];
    const line = text.split('\n').find((l) => l.includes('`?tier=fast&public=1` / `?tier=slow&public=1`'))!;
    const failures = validateBootstrapCacheDocs(REAL_STATS, { [EN_PAGE]: `${text}\n${line}\n` });
    assert.ok(hit(failures, 'found 2'));
  });
});
