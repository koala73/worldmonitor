import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CII_RISK_SCORE_CACHE_KEYS } from '../api/_cii-risk-cache-keys.js';
import { __testing__ as healthTesting } from '../api/health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('Bootstrap cache key registry', () => {
  const cacheKeysPath = join(root, 'server', '_shared', 'cache-keys.ts');
  const cacheKeysSrc = readFileSync(cacheKeysPath, 'utf-8');
  const bootstrapSrc = readFileSync(join(root, 'api', 'bootstrap.js'), 'utf-8');

  const cacheKeysBlock = cacheKeysSrc.match(/BOOTSTRAP_CACHE_KEYS[^{]*\{([^}]+)\}/)?.[1] ?? '';

  const resolveCiiCacheKeyRef = (prop) => {
    assert.ok(
      Object.hasOwn(CII_RISK_SCORE_CACHE_KEYS, prop),
      `Unknown CII_RISK_SCORE_CACHE_KEYS property '${prop}'`,
    );
    return CII_RISK_SCORE_CACHE_KEYS[prop];
  };

  it('exports BOOTSTRAP_CACHE_KEYS with at least 10 entries', () => {
    const matches = cacheKeysBlock.match(/^\s+\w+:\s+'[^']+'/gm);
    assert.ok(matches && matches.length >= 10, `Expected ≥10 keys, found ${matches?.length ?? 0}`);
  });

  it('api/bootstrap.js inlined keys match server/_shared/cache-keys.ts', () => {
    const extractKeys = (src) => {
      const block = src.match(/BOOTSTRAP_CACHE_KEYS[^=]*=\s*\{([^}]+)\}/);
      if (!block) return {};
      const re = /(\w+):\s*(?:'([a-z0-9_-]+(?::[a-z0-9_-]+)+)'|CII_RISK_SCORE_CACHE_KEYS\.(\w+))/g;
      const keys = {};
      let m;
      while ((m = re.exec(block[1])) !== null) {
        keys[m[1]] = m[2] ?? resolveCiiCacheKeyRef(m[3]);
      }
      return keys;
    };
    const canonical = extractKeys(cacheKeysSrc);
    const inlined = extractKeys(bootstrapSrc);
    assert.ok(Object.keys(canonical).length >= 10, 'Canonical registry too small');
    for (const [name, key] of Object.entries(canonical)) {
      assert.equal(inlined[name], key, `Key '${name}' mismatch: canonical='${key}', inlined='${inlined[name]}'`);
    }
    for (const [name, key] of Object.entries(inlined)) {
      assert.equal(canonical[name], key, `Extra inlined key '${name}' not in canonical registry`);
    }
  });

  it('every cache key matches a handler cache key pattern', () => {
    const keyRe = /:\s*(?:'([^']+)'|CII_RISK_SCORE_CACHE_KEYS\.(\w+))/g;
    let m;
    const keys = [];
    while ((m = keyRe.exec(cacheKeysBlock)) !== null) {
      keys.push(m[1] ?? resolveCiiCacheKeyRef(m[2]));
    }
    for (const key of keys) {
      assert.match(key, /^[a-z0-9_-]+(?::[a-z0-9_-]+)+(?::v\d+)?(?::[a-z0-9_-]+)*$/, `Cache key "${key}" does not match expected pattern`);
    }
  });

  it('has no duplicate cache keys', () => {
    const keyRe = /:\s*(?:'([^']+)'|CII_RISK_SCORE_CACHE_KEYS\.(\w+))/g;
    let m;
    const keys = [];
    while ((m = keyRe.exec(cacheKeysBlock)) !== null) {
      keys.push(m[1] ?? resolveCiiCacheKeyRef(m[2]));
    }
    const unique = new Set(keys);
    assert.equal(unique.size, keys.length, `Found duplicate cache keys: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`);
  });

  it('has no duplicate logical names', () => {
    const nameRe = /^\s+(\w+):/gm;
    let m;
    const names = [];
    while ((m = nameRe.exec(cacheKeysBlock)) !== null) {
      names.push(m[1]);
    }
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `Found duplicate names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('every cache key maps to a handler file or external seed script', () => {
    const block = cacheKeysSrc.match(/BOOTSTRAP_CACHE_KEYS[^{]*\{([^}]+)\}/);
    const keyRe = /:\s+'([^']+)'/g;
    let m;
    const keys = [];
    while ((m = keyRe.exec(block[1])) !== null) {
      keys.push(m[1]);
    }

    const handlerDirs = join(root, 'server', 'worldmonitor');
    const handlerFiles = [];
    function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && !entry.includes('service_server') && !entry.includes('service_client')) {
          handlerFiles.push(full);
        }
      }
    }
    walk(handlerDirs);
    const allHandlerCode = handlerFiles.map(f => readFileSync(f, 'utf-8')).join('\n');

    const seedFiles = readdirSync(join(root, 'scripts'))
      .filter(f => f.startsWith('seed-') && f.endsWith('.mjs'))
      .map(f => readFileSync(join(root, 'scripts', f), 'utf-8'))
      .join('\n');
    const healthSrc = readFileSync(join(root, 'api', 'health.js'), 'utf-8');
    const allSearchable = allHandlerCode + '\n' + seedFiles + '\n' + healthSrc;

    for (const key of keys) {
      assert.ok(
        allSearchable.includes(key),
        `Cache key "${key}" not found in any handler file or seed script`,
      );
    }
  });
});

describe('Bootstrap endpoint (api/bootstrap.js)', () => {
  const bootstrapPath = join(root, 'api', 'bootstrap.js');
  const src = readFileSync(bootstrapPath, 'utf-8');

  function collectBootstrapApiHelperImports(entryRelPath, seen = new Set()) {
    const absolutePath = join(root, entryRelPath);
    const normalized = entryRelPath.replace(/\\/g, '/');
    if (seen.has(normalized)) return seen;
    seen.add(normalized);

    const source = readFileSync(absolutePath, 'utf-8');
    const importRe = /from\s+['"](\.\/_[^'"]+\.js)['"]/g;
    let match;
    while ((match = importRe.exec(source)) !== null) {
      collectBootstrapApiHelperImports(`api/${match[1].slice(2)}`, seen);
    }
    return seen;
  }

  it('exports edge runtime config', () => {
    assert.ok(src.includes("runtime: 'edge'"), 'Missing edge runtime config');
  });

  it('defines BOOTSTRAP_CACHE_KEYS inline', () => {
    assert.ok(src.includes('BOOTSTRAP_CACHE_KEYS'), 'Missing BOOTSTRAP_CACHE_KEYS definition');
  });

  it('defines getCachedJsonBatch inline (self-contained, no server imports)', () => {
    assert.ok(src.includes('getCachedJsonBatch'), 'Missing getCachedJsonBatch function');
    assert.ok(!src.includes("from '../server/"), 'Should not import from server/ — Edge Functions cannot resolve cross-directory TS imports');
  });

  it('keeps bootstrap and transitive api helpers inside the Edge-safe API boundary', () => {
    const checked = [...collectBootstrapApiHelperImports('api/bootstrap.js')];
    const forbiddenImport = /from\s+['"](?:\.\.\/(?:server|src)\/|node:)/;
    const forbiddenDynamicImport = /import\s*\(\s*['"](?:\.\.\/(?:server|src)\/|node:)/;
    for (const relPath of checked) {
      const source = readFileSync(join(root, relPath), 'utf-8');
      assert.doesNotMatch(source, forbiddenImport, `${relPath} must not import server/src modules or Node built-ins`);
      assert.doesNotMatch(source, forbiddenDynamicImport, `${relPath} must not dynamically import server/src modules or Node built-ins`);
    }
  });

  it('supports optional ?keys= query param for subset filtering', () => {
    assert.ok(src.includes("'keys'"), 'Missing keys query param handling');
  });

  it('returns JSON with data and missing keys', () => {
    assert.ok(src.includes('data'), 'Missing data field in response');
    assert.ok(src.includes('missing'), 'Missing missing field in response');
  });

  it('sets Cache-Control header with s-maxage for both tiers', () => {
    // Cache-Control uses browser-only max-age (no s-maxage) so CF does not cache and
    // pin a single ACAO origin. Vercel CDN uses CDN-Cache-Control for edge caching.
    assert.ok(src.includes('max-age='), 'Missing max-age in Cache-Control');
    assert.ok(src.includes('stale-while-revalidate'), 'Missing stale-while-revalidate');
    assert.ok(src.includes('CDN-Cache-Control'), 'Missing CDN-Cache-Control for Vercel CDN');
  });

  it('validates API key for desktop origins', () => {
    assert.ok(src.includes('validateApiKey'), 'Missing API key validation');
  });

  it('handles CORS preflight', () => {
    assert.ok(src.includes("'OPTIONS'"), 'Missing OPTIONS method handling');
    assert.ok(src.includes('getCorsHeaders'), 'Missing CORS headers');
  });

  it('supports ?tier= query param for tiered fetching', () => {
    assert.ok(src.includes("'tier'"), 'Missing tier query param handling');
    assert.ok(src.includes('SLOW_KEYS'), 'Missing SLOW_KEYS set');
    assert.ok(src.includes('FAST_KEYS'), 'Missing FAST_KEYS set');
    assert.ok(src.includes('TIER_CACHE'), 'Missing TIER_CACHE map');
  });
});

describe('Frontend hydration (src/services/bootstrap.ts)', () => {
  const bootstrapClientPath = join(root, 'src', 'services', 'bootstrap.ts');
  const src = readFileSync(bootstrapClientPath, 'utf-8');

  it('exports getHydratedData function', () => {
    assert.ok(src.includes('export function getHydratedData'), 'Missing getHydratedData export');
  });

  it('exports fetchBootstrapData function', () => {
    assert.ok(src.includes('export async function fetchBootstrapData'), 'Missing fetchBootstrapData export');
  });

  it('uses consume-once pattern (deletes after read)', () => {
    assert.ok(src.includes('.delete('), 'Missing delete in getHydratedData — consume-once pattern not implemented');
  });

  it('has a fast timeout cap to avoid regressing startup', () => {
    const timeoutMatches = [...src.matchAll(/setTimeout\([^,]+,\s*(?:desktop\s*\?\s*[\d_]+\s*:\s*)?(\d[\d_]*)\)/g)];
    assert.ok(timeoutMatches.length > 0, 'Missing timeout');
    for (const m of timeoutMatches) {
      const ms = parseInt(m[1].replace(/_/g, ''), 10);
      assert.ok(ms <= 5000, `Timeout ${ms}ms too high — should be ≤5000ms to avoid regressing startup`);
    }
  });

  it('keeps web bootstrap tier timeouts within budget', () => {
    const timeouts = Array.from(src.matchAll(/(\d[_\d]*)\)/g))
      .map((m) => parseInt(m[1].replace(/_/g, ''), 10))
      .filter((n) => n === 1200 || n === 3000);
    assert.deepEqual(
      timeouts.toSorted((a, b) => a - b),
      [1200, 3000],
      `Expected web bootstrap timeouts (fast=1200, slow=3000) — slow tier was bumped from 1.8s to 3.0s to avoid hydration-cascade aborts`,
    );
  });

  it('allows longer bootstrap timeouts for desktop runtime', () => {
    assert.ok(src.includes('isDesktopRuntime'), 'Bootstrap should branch on desktop for longer timeouts');
  });

  it('fetches tiered bootstrap URLs', () => {
    assert.ok(src.includes('/api/bootstrap?tier='), 'Missing tiered bootstrap fetch URLs');
    assert.ok(src.includes('&public=1'), 'Tiered bootstrap fetches must use the isolated public cache URL');
    assert.ok(src.includes("credentials: 'omit'"), 'Public tier fetches must omit credentials');
  });

  it('handles fetch failure silently', () => {
    assert.ok(src.includes('catch'), 'Missing error handling — panels should fall through to individual calls');
  });

  it('awaits only the fast tier; backgrounds the slow tier (#4488 — slow off the boot critical path)', () => {
    assert.ok(src.includes("'slow'"), 'Missing slow tier fetch');
    assert.ok(src.includes("'fast'"), 'Missing fast tier fetch');
    // The ~410KB slow tier must NOT block first paint: the boot must not await both tiers
    // together. A regression to `await Promise.all([fetchTier('slow'), fetchTier('fast')])`
    // re-introduces the LCP-blocking boot this deferral removed.
    assert.ok(
      !/await\s+Promise\.all\(\s*\[\s*fetchTier\('slow'/.test(src),
      'slow tier must not be awaited via Promise.all — background it so it stays off the first-paint critical path',
    );
    // Slow tier is scheduled only after the fast state is committed.
    assert.ok(src.includes('scheduleSlowTierFetch'), 'slow tier should be scheduled through the deferred slow-tier helper');
    assert.ok(src.includes('slowTierSettled = scheduleSlowTierFetch'), 'fetchBootstrapData should expose the background slow-tier checkpoint');
    assert.ok(/await\s+fetchTier\('fast'/.test(src), "boot should await the fast tier: await fetchTier('fast', …)");
  });

  it('guards stale slow-tier generations before committing cache or hydration state', () => {
    assert.ok(src.includes('bootstrapGeneration'), 'Missing bootstrap generation guard');
    assert.ok(src.includes('isCurrentGeneration'), 'Missing current-generation predicate');
    assert.ok(src.includes('fetchTier(') && src.includes('shouldCommit'), 'fetchTier should receive a commit guard');
  });
});

describe('App bootstrap slow-tier lifecycle', () => {
  const appSrc = readFileSync(join(root, 'src', 'App.ts'), 'utf-8');

  it('does not update connectivity UI from a slow callback after destroy', () => {
    assert.match(
      appSrc,
      /fetchBootstrapData\(\(\) => \{\s*if \(this\.state\.isDestroyed\) return;\s*this\.bootstrapHydrationState = getBootstrapHydrationState\(\);\s*this\.updateConnectivityUi\(\);/s,
      'slow-tier callback should bail out after App.destroy()',
    );
    assert.ok(appSrc.includes('cancelBootstrapSlowTier();'), 'App.destroy() should cancel pending slow bootstrap work');
  });

  it('keeps country geometry off the visible data fan-out while awaiting the slow tier (#4489/#4512)', () => {
    const phase6Start = appSrc.indexOf('// Phase 6: Data loading');
    const phase6End = appSrc.indexOf('// If bootstrap was served from cache', phase6Start);
    const phase6 = appSrc.slice(phase6Start, phase6End);
    const slowStartIndex = phase6.indexOf('const slowTierReady = this.waitForSlowBootstrapCheckpoint();');
    const slowAwaitIndex = phase6.indexOf('await slowTierReady;');
    const fanoutIndex = phase6.indexOf('this.dataLoader.loadAllData()');
    const countryGeometryIndex = phase6.indexOf('const countryGeometryReady = this.preloadCountryGeometryForPostLcpWork();');

    assert.ok(phase6Start >= 0 && phase6End > phase6Start, 'Missing Phase 6 data loading block');
    assert.ok(slowStartIndex >= 0, 'slow-tier checkpoint should still start in the background');
    // Slow-tier hydration keys are consume-once: the fan-out must NOT read them
    // before the tier settles, so the bounded checkpoint is awaited first (#4512).
    assert.ok(slowAwaitIndex > slowStartIndex, 'slow-tier checkpoint should be awaited before the fan-out');
    assert.ok(fanoutIndex > slowAwaitIndex, 'visible data fan-out should start after the slow-tier checkpoint settles');
    assert.ok(countryGeometryIndex > fanoutIndex, 'country geometry preload should start after initial visible data fan-out');
    // Country geometry preload must stay deferred — re-introducing a pre-fanout
    // await here is the exact regression this guard exists to catch.
    const preFanout = phase6.slice(0, fanoutIndex);
    assert.ok(!/await\s+preloadCountryGeometry\s*\(/.test(preFanout), 'country geometry must not be awaited before the fan-out');
    assert.ok(!/await\s+waitForBootstrapSlowTier\s*\(/.test(preFanout), 'raw slow-tier wait must not be inlined before the fan-out');
    assert.ok(!phase6.includes('void slowTierReady;'), 'slow-tier checkpoint must be awaited, not discarded');
    assert.ok(appSrc.includes('this.startPostLcpIntelligence(countryGeometryReady, geometryReadyBeforeFanout);'), 'post-LCP intelligence should wait on background geometry and know whether geometry was already applied');
    assert.ok(appSrc.includes('this.dataLoader.refreshGeometryDependentCiiAfterCountryGeometry();'), 'post-geometry replay should restore CII country attribution without blocking fan-out');
  });
});

describe('Panel hydration consumers', () => {
  const panels = [
    { name: 'ETFFlowsPanel', path: 'src/components/ETFFlowsPanel.ts', key: 'etfFlows' },
    { name: 'MacroSignalsPanel', path: 'src/components/MacroSignalsPanel.ts', key: 'macroSignals' },
    { name: 'ServiceStatusPanel (via infrastructure)', path: 'src/services/infrastructure/index.ts', key: 'serviceStatuses' },
    { name: 'Sectors (via data-loader)', path: 'src/app/data-loader.ts', key: 'sectors' },
  ];

  for (const panel of panels) {
    it(`${panel.name} checks getHydratedData('${panel.key}')`, () => {
      const src = readFileSync(join(root, panel.path), 'utf-8');
      assert.ok(src.includes('getHydratedData'), `${panel.name} missing getHydratedData import/usage`);
      assert.ok(src.includes(`'${panel.key}'`), `${panel.name} missing hydration key '${panel.key}'`);
    });
  }
});

// The slow tier is fetched in the BACKGROUND (off the boot critical path, #4488), so any
// slow-tier consumer that read its hydration WITHOUT an on-demand fetch fallback would break
// (empty panel). This guard enforces the greppable half — every bootstrap key (incl. all
// SLOW_KEYS) has a getHydratedData consumer or is allow-listed below. The fetch-on-absence
// half is a manual audit (a getHydratedData call alone can't prove the adjacent RPC is the
// fallback); the #4488 audit confirmed every slow-key consumer is hydrated-else-fetch.
describe('Bootstrap key hydration coverage', () => {
  it('every bootstrap key has a getHydratedData consumer in src/', () => {
    const bootstrapSrc = readFileSync(join(root, 'api', 'bootstrap.js'), 'utf-8');
    const block = bootstrapSrc.match(/BOOTSTRAP_CACHE_KEYS\s*=\s*\{([^}]+)\}/);
    const keyRe = /(\w+):\s*(?:'[a-z0-9_-]+(?::[a-z0-9_-]+)+'|CII_RISK_SCORE_CACHE_KEYS\.\w+)/g;
    const keys = [];
    let m;
    while ((m = keyRe.exec(block[1])) !== null) keys.push(m[1]);

    const srcFiles = [];
    function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && !full.includes('/generated/')) srcFiles.push(full);
      }
    }
    walk(join(root, 'src'));
    const allSrc = srcFiles.map(f => readFileSync(f, 'utf-8')).join('\n');

    // Keys with planned but not-yet-wired consumers
    const PENDING_CONSUMERS = new Set([
      'correlationCards', 'euGasStorage', 'chokepointBaselines', 'imfMacro',
      'imfGrowth', 'imfLabor', 'imfExternal',
      'portwatchChokepointsRef', 'portwatchPortActivity', 'sprPolicies',
      'wsbTickers', 'electricityPrices', 'jodiOil',
      'eurostatHousePrices', 'eurostatGovDebtQ', 'eurostatIndProd',
      // BIS extended dataflows are consumed via a direct scoped bootstrap
      // fetch in CountryDeepDivePanel (housing cycle tile), not through the
      // getHydratedData session cache — fetched on-click per country.
      'bisDsr', 'bisPropertyResidential', 'bisPropertyCommercial',
      // energyDisruptions is bootstrap-hydrated so the RPC handler has
      // warm data, but panel drawers fetch events lazily via
      // listEnergyDisruptions() on drawer open — no getHydratedData()
      // call site. Classifier extends this post-launch.
      'energyDisruptions',
    ]);
    for (const key of keys) {
      if (PENDING_CONSUMERS.has(key)) continue;
      assert.ok(
        allSrc.includes(`getHydratedData('${key}')`),
        `Bootstrap key '${key}' has no getHydratedData('${key}') consumer in src/ — data is fetched but never used`,
      );
    }
  });
});

describe('Health key registries', () => {
  it('does not duplicate Redis keys across BOOTSTRAP_KEYS and STANDALONE_KEYS', () => {
    const bootstrap = new Set(Object.values(healthTesting.BOOTSTRAP_KEYS));
    const standalone = new Set(Object.values(healthTesting.STANDALONE_KEYS));
    const overlap = [...bootstrap].filter((key) => standalone.has(key));

    assert.deepEqual(overlap, [], `health.js duplicates keys across registries: ${overlap.join(', ')}`);
  });
});

describe('Bootstrap tier definitions', () => {
  const bootstrapSrc = readFileSync(join(root, 'api', 'bootstrap.js'), 'utf-8');
  const cacheKeysSrc = readFileSync(join(root, 'server', '_shared', 'cache-keys.ts'), 'utf-8');

  function extractSetKeys(src, varName) {
    const re = new RegExp(`${varName}\\s*=\\s*new Set\\(\\[([^\\]]+)\\]`, 's');
    const m = src.match(re);
    if (!m) return new Set();
    return new Set([...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]));
  }

  function extractBootstrapKeys(src) {
    const block = src.match(/BOOTSTRAP_CACHE_KEYS\s*=\s*\{([^}]+)\}/);
    if (!block) return new Set();
    return new Set([...block[1].matchAll(/(\w+):\s*(?:'|CII_RISK_SCORE_CACHE_KEYS\.)/g)].map(x => x[1]));
  }

  function extractTierKeys(src) {
    const block = src.match(/BOOTSTRAP_TIERS[^{]*\{([^}]+)\}/);
    if (!block) return {};
    const result = {};
    for (const m of block[1].matchAll(/(\w+):\s+'(slow|fast)'/g)) {
      result[m[1]] = m[2];
    }
    return result;
  }

  it('SLOW_KEYS + FAST_KEYS cover all BOOTSTRAP_CACHE_KEYS with no overlap', () => {
    const slow = extractSetKeys(bootstrapSrc, 'SLOW_KEYS');
    const fast = extractSetKeys(bootstrapSrc, 'FAST_KEYS');
    const all = extractBootstrapKeys(bootstrapSrc);

    const union = new Set([...slow, ...fast]);
    assert.deepEqual([...union].sort(), [...all].sort(), 'SLOW_KEYS ∪ FAST_KEYS must equal BOOTSTRAP_CACHE_KEYS');

    const intersection = [...slow].filter(k => fast.has(k));
    assert.equal(intersection.length, 0, `Overlap between tiers: ${intersection.join(', ')}`);
  });

  it('tier sets in bootstrap.js match BOOTSTRAP_TIERS in cache-keys.ts', () => {
    const slow = extractSetKeys(bootstrapSrc, 'SLOW_KEYS');
    const fast = extractSetKeys(bootstrapSrc, 'FAST_KEYS');
    const tiers = extractTierKeys(cacheKeysSrc);

    for (const k of slow) {
      assert.equal(tiers[k], 'slow', `SLOW_KEYS has '${k}' but BOOTSTRAP_TIERS says '${tiers[k]}'`);
    }
    for (const k of fast) {
      assert.equal(tiers[k], 'fast', `FAST_KEYS has '${k}' but BOOTSTRAP_TIERS says '${tiers[k]}'`);
    }
    const tierKeys = new Set(Object.keys(tiers));
    const setKeys = new Set([...slow, ...fast]);
    assert.deepEqual([...tierKeys].sort(), [...setKeys].sort(), 'BOOTSTRAP_TIERS keys must match SLOW_KEYS ∪ FAST_KEYS');
  });
});

describe('Adaptive backoff adopters', () => {
  it('ServiceStatusPanel.fetchStatus returns Promise<boolean>', () => {
    const src = readFileSync(join(root, 'src/components/ServiceStatusPanel.ts'), 'utf-8');
    assert.ok(src.includes('fetchStatus(): Promise<boolean>'), 'fetchStatus should return Promise<boolean> for adaptive backoff');
    assert.ok(src.includes('lastServicesJson'), 'Missing lastServicesJson for change detection');
  });

  it('MacroSignalsPanel.fetchData returns Promise<boolean>', () => {
    const src = readFileSync(join(root, 'src/components/MacroSignalsPanel.ts'), 'utf-8');
    assert.ok(src.includes('fetchData(): Promise<boolean>'), 'fetchData should return Promise<boolean> for adaptive backoff');
    assert.ok(src.includes('lastTimestamp'), 'Missing lastTimestamp for change detection');
  });

  it('StrategicRiskPanel.refresh returns Promise<boolean>', () => {
    const src = readFileSync(join(root, 'src/components/StrategicRiskPanel.ts'), 'utf-8');
    assert.ok(src.includes('refresh(): Promise<boolean>'), 'refresh should return Promise<boolean> for adaptive backoff');
    assert.ok(src.includes('lastRiskFingerprint'), 'Missing lastRiskFingerprint for change detection');
  });
});
