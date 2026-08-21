import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOOTSTRAP_CACHE_KEYS as CANONICAL_BOOTSTRAP_CACHE_KEYS,
  BOOTSTRAP_TIERS as CANONICAL_BOOTSTRAP_TIERS,
  bootstrapTierKeyNames,
} from '../shared/bootstrap-tier-keys.js';
import {
  BOOTSTRAP_CACHE_KEYS as EDGE_BOOTSTRAP_CACHE_KEYS,
  BOOTSTRAP_TIERS as EDGE_BOOTSTRAP_TIERS,
} from '../api/_bootstrap-tier-keys.js';
import { CANADA_ROAD_SOURCES } from '../src/services/canada-roads-core.ts';
import { CII_RISK_SCORE_CACHE_KEYS } from '../api/_cii-risk-cache-keys.js';
import { BOOTSTRAP_TIER_TIMEOUT_MS } from '../src/services/bootstrap.ts';
import { __testing__ as healthTesting } from '../api/health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function hasHydrationConsumer(source, key) {
  if (source.includes(`getHydratedData('${key}')`) || source.includes(`ensureHydrated('${key}')`)) {
    return true;
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\bcreateHydrationHandoff(?:\\s*<[^>]+>)?\\s*\\(\\s*['"]${escapedKey}['"]`,
  ).test(source);
}

// Keys the repo already knows nothing consumes: planned-but-unwired, or fetched by
// some route other than tier hydration. Module-scoped so BOTH guards can use it —
// the hydration-coverage test (which allows them) and the tier-freeloader test
// (which forbids them from riding in a bundle every client downloads). #5300.
const PENDING_CONSUMERS = new Set([ 'chokepointBaselines', 'imfMacro',
      'imfGrowth', 'imfLabor', 'imfExternal',
      'portwatchChokepointsRef', 'portwatchPortActivity', 'sprPolicies', 'electricityPrices', 'jodiOil',
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

describe('Bootstrap cache key registry', () => {
  const cacheKeysPath = join(root, 'server', '_shared', 'cache-keys.ts');
  const cacheKeysSrc = readFileSync(cacheKeysPath, 'utf-8');
  const bootstrapSrc = readFileSync(join(root, 'api', 'bootstrap.js'), 'utf-8');

  it('exports BOOTSTRAP_CACHE_KEYS with at least 10 entries', () => {
    assert.ok(
      Object.keys(CANONICAL_BOOTSTRAP_CACHE_KEYS).length >= 10,
      `Expected ≥10 keys, found ${Object.keys(CANONICAL_BOOTSTRAP_CACHE_KEYS).length}`,
    );
  });

  // R4 (#6654): the X feed carries post bodies, and every bootstrap tier is
  // reachable unauthenticated at `?tier=<t>&public=1` with ACAO:* and a 2h CDN
  // shield — the embed/OEM + server-to-server audience R4 excludes. The panel
  // fetches post text from /api/x-feed instead, and telegramFeed is kept out of
  // this registry for the same reason. Registering it here would republish
  // tweet bodies to anonymous callers.
  it('keeps the X feed OUT of bootstrap hydration so post bodies stay first-party', () => {
    assert.equal(CANONICAL_BOOTSTRAP_CACHE_KEYS.xFeed, undefined);
    assert.equal(CANONICAL_BOOTSTRAP_TIERS.xFeed, undefined);
    assert.equal(EDGE_BOOTSTRAP_CACHE_KEYS.xFeed, undefined);
    assert.equal(EDGE_BOOTSTRAP_TIERS.xFeed, undefined);
    // Same rule, stated against the sibling feed it mirrors.
    assert.equal(CANONICAL_BOOTSTRAP_CACHE_KEYS.telegramFeed, undefined);
    for (const tier of ['fast', 'slow', 'on-demand']) {
      assert.ok(
        !bootstrapTierKeyNames(tier).includes('xFeed'),
        `xFeed must not appear in the ${tier} tier`,
      );
    }
  });

  it('generated edge mirror exactly matches the authored shared registry', () => {
    assert.deepEqual(EDGE_BOOTSTRAP_CACHE_KEYS, CANONICAL_BOOTSTRAP_CACHE_KEYS);
    assert.deepEqual(EDGE_BOOTSTRAP_TIERS, CANONICAL_BOOTSTRAP_TIERS);
    assert.equal(
      CANONICAL_BOOTSTRAP_CACHE_KEYS.riskScores,
      CII_RISK_SCORE_CACHE_KEYS.stale,
      'the canonical bootstrap registry must track the current CII stale key',
    );
  });

  it('server and edge consumers import their deployment-safe registry module', () => {
    assert.match(
      cacheKeysSrc,
      /export\s*\{\s*BOOTSTRAP_CACHE_KEYS,\s*BOOTSTRAP_TIERS\s*\}\s*from\s*'\.\.\/\.\.\/shared\/bootstrap-tier-keys\.js'/,
    );
    assert.match(
      bootstrapSrc,
      /from\s+'\.\/_bootstrap-tier-keys\.js'/,
      'the edge route must import the generated same-directory mirror',
    );
  });

  it('every cache key matches a handler cache key pattern', () => {
    for (const key of Object.values(CANONICAL_BOOTSTRAP_CACHE_KEYS)) {
      assert.match(key, /^[a-z0-9_-]+(?::[a-z0-9_-]+)+(?::v\d+)?(?::[a-z0-9_-]+)*$/, `Cache key "${key}" does not match expected pattern`);
    }
  });

  it('has no duplicate cache keys', () => {
    const keys = Object.values(CANONICAL_BOOTSTRAP_CACHE_KEYS);
    const unique = new Set(keys);
    assert.equal(unique.size, keys.length, `Found duplicate cache keys: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`);
  });

  it('has no duplicate logical names', () => {
    const names = Object.keys(CANONICAL_BOOTSTRAP_CACHE_KEYS);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `Found duplicate names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('assigns every registered key to exactly one tier without changing insertion order', () => {
    assert.deepEqual(Object.keys(CANONICAL_BOOTSTRAP_TIERS), Object.keys(CANONICAL_BOOTSTRAP_CACHE_KEYS));
    const assigned = [
      ...bootstrapTierKeyNames('fast'),
      ...bootstrapTierKeyNames('slow'),
      ...bootstrapTierKeyNames('on-demand'),
    ];
    assert.equal(new Set(assigned).size, Object.keys(CANONICAL_BOOTSTRAP_CACHE_KEYS).length);
  });

  it('every cache key maps to a handler file or external seed script', () => {
    const keys = Object.values(CANONICAL_BOOTSTRAP_CACHE_KEYS);

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
    const ciiKeySrc = readFileSync(join(root, 'scripts', '_cii-risk-cache-keys.mjs'), 'utf-8');
    const chinaMacroContractSrc = readFileSync(
      join(root, 'scripts', '_china-macro-contract.mjs'),
      'utf-8',
    );
    const allSearchable = [
      allHandlerCode,
      seedFiles,
      healthSrc,
      ciiKeySrc,
      chinaMacroContractSrc,
    ].join('\n');

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

  it('resolves BOOTSTRAP_CACHE_KEYS from the generated edge registry', () => {
    assert.match(src, /from '\.\/_bootstrap-tier-keys\.js'/);
    assert.ok(src.includes('BOOTSTRAP_CACHE_KEYS'), 'Missing BOOTSTRAP_CACHE_KEYS runtime registry');
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

  // The query-param, header and tier-set assertions that used to sit here were
  // `src.includes('data')`, `src.includes('keys')`, `src.includes('catch')` and
  // friends — substrings common enough to pass against almost any JavaScript
  // file, so they could not fail. The endpoint's actual behaviour is exercised
  // by the runtime suite in tests/bootstrap-runtime.test.mts; what is worth
  // reading off the source is the Edge boundary above, which no runtime test
  // can observe.

});

describe('Frontend bootstrap tier budgets', () => {
  // Behaviour (consume-once hydration, tier ordering, stale-generation guards,
  // silent slow-tier failure) is exercised against the real functions in
  // tests/bootstrap-runtime.test.mts. What remains here is the timeout budget,
  // which is a deliberate product constraint rather than an implementation
  // detail — and is now read from the exported constant instead of by
  // regex-scanning the module for bare numeric literals.
  it('keeps the web fast tier off the first-paint critical path', () => {
    assert.ok(
      BOOTSTRAP_TIER_TIMEOUT_MS.web.fast <= 1_500,
      `web fast tier budget ${BOOTSTRAP_TIER_TIMEOUT_MS.web.fast}ms blocks first paint too long`,
    );
  });

  it('gives the slow tier more room than the fast tier, on both runtimes', () => {
    for (const runtime of ['web', 'desktop']) {
      const { fast, slow } = BOOTSTRAP_TIER_TIMEOUT_MS[runtime];
      assert.ok(slow > fast, `${runtime}: slow budget must exceed fast`);
    }
  });

  it('keeps every budget inside the 8s ceiling that panels fall back at', () => {
    for (const runtime of ['web', 'desktop']) {
      for (const [tier, ms] of Object.entries(BOOTSTRAP_TIER_TIMEOUT_MS[runtime])) {
        assert.ok(ms > 0 && ms <= 8_000, `${runtime}.${tier} budget ${ms}ms is out of range`);
      }
    }
  });

  it('allows desktop longer budgets than web on every tier', () => {
    // Different network and dependency-loading constraints; a web budget that
    // drifted above desktop's would mean the tuning got inverted.
    for (const tier of ['fast', 'slow']) {
      assert.ok(
        BOOTSTRAP_TIER_TIMEOUT_MS.desktop[tier] > BOOTSTRAP_TIER_TIMEOUT_MS.web[tier],
        `desktop ${tier} budget must exceed web`,
      );
    }
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
    assert.ok(appSrc.includes('this.dataLoader.refreshGeometryDependentCountryData();'), 'post-geometry replay should restore country-detail attribution without blocking fan-out');
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
    const keys = Object.keys(CANONICAL_BOOTSTRAP_CACHE_KEYS);

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

    // A third valid form: a key consumed through a loader map DERIVED from a
    // descriptor list rather than named in a per-key literal. #6763 built the
    // Canada road loaders as `CANADA_ROAD_SOURCES.map(({ key }) => ...)`
    // precisely so a fifth jurisdiction cannot be added with no loader and read
    // as permanently unavailable — the failure hand-listed literals invite.
    //
    // This follows the derivation instead of forcing the literals back, and
    // stays honest by requiring the derivation site to exist: delete it and
    // every road key falls through to the assertion below.
    const derivedRoadKeys = new Set(
      /CANADA_ROAD_SOURCES\.map\(\(\{ key \}\) => \[key, \(\) => ensureHydrated\(key\)\]\)/.test(allSrc)
        ? CANADA_ROAD_SOURCES.map(({ key }) => key)
        : [],
    );

    for (const key of keys) {
      if (PENDING_CONSUMERS.has(key)) continue;
      if (derivedRoadKeys.has(key)) continue;
      // Three valid consumer forms. `getHydratedData(k)` reads a key delivered by a
      // tier bundle. `ensureHydrated(k)` (#5300) reads a key that rides in no
      // tier: it returns the tier value if one is present and otherwise fetches
      // the key through its own CDN-shielded `?keys=<k>&public=1` URL.
      // `createHydrationHandoff(k)` (#7048) consumes through the same one-shot
      // reader and retains only accepted data in a bounded service cache.
      assert.ok(
        hasHydrationConsumer(allSrc, key),
        `Bootstrap key '${key}' has no direct, ensured, or handoff hydration consumer in src/ — data is fetched but never used`,
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
  const tierKeys = (tier) => new Set(bootstrapTierKeyNames(tier));

  // Every registered key must be classified exactly once: it rides in the fast
  // tier, the slow tier, or neither (ON_DEMAND_KEYS — fetched per-key, only by
  // the clients that render it; #5300). "Neither" is now a deliberate state, not
  // an omission, so it needs a home in the invariant rather than a hole in it.
  it('SLOW_KEYS + FAST_KEYS + ON_DEMAND_KEYS cover all BOOTSTRAP_CACHE_KEYS with no overlap', () => {
    const slow = tierKeys('slow');
    const fast = tierKeys('fast');
    const onDemand = tierKeys('on-demand');
    const all = new Set(Object.keys(CANONICAL_BOOTSTRAP_CACHE_KEYS));

    const union = new Set([...slow, ...fast, ...onDemand]);
    assert.deepEqual([...union].sort(), [...all].sort(), 'SLOW ∪ FAST ∪ ON_DEMAND must equal BOOTSTRAP_CACHE_KEYS');

    for (const [a, b, label] of [[slow, fast, 'slow/fast'], [slow, onDemand, 'slow/on-demand'], [fast, onDemand, 'fast/on-demand']]) {
      const overlap = [...a].filter(k => b.has(k));
      assert.equal(overlap.length, 0, `Overlap between ${label}: ${overlap.join(', ')}`);
    }
  });

  it('canonical key sets match canonical BOOTSTRAP_TIERS', () => {
    const slow = tierKeys('slow');
    const fast = tierKeys('fast');
    const onDemand = tierKeys('on-demand');
    const tiers = CANONICAL_BOOTSTRAP_TIERS;

    for (const k of slow) {
      assert.equal(tiers[k], 'slow', `SLOW_KEYS has '${k}' but BOOTSTRAP_TIERS says '${tiers[k]}'`);
    }
    for (const k of fast) {
      assert.equal(tiers[k], 'fast', `FAST_KEYS has '${k}' but BOOTSTRAP_TIERS says '${tiers[k]}'`);
    }
    for (const k of onDemand) {
      assert.equal(tiers[k], 'on-demand', `ON_DEMAND_KEYS has '${k}' but BOOTSTRAP_TIERS says '${tiers[k]}'`);
    }
    const assignedTierKeys = new Set(Object.keys(tiers));
    const setKeys = new Set([...slow, ...fast, ...onDemand]);
    assert.deepEqual([...assignedTierKeys].sort(), [...setKeys].sort(), 'BOOTSTRAP_TIERS keys must match SLOW ∪ FAST ∪ ON_DEMAND');
  });

  // The structural guard. A tier bundle is downloaded by EVERY client on EVERY boot,
  // so a key earns its place there only if a client actually reads its hydration.
  // Scan the source for real consumers — do NOT trust PENDING_CONSUMERS here: it is
  // an allow-list that goes stale the moment a consumer is wired up (euGasStorage,
  // correlationCards and wsbTickers were all still on it long after they had one).
  // A key with no getHydratedData/ensureHydrated call site is freight: ship it
  // on demand instead (#5300).
  it('every tier key has a hydration consumer — a tier is not a dumping ground', () => {
    const slow = tierKeys('slow');
    const fast = tierKeys('fast');

    const srcFiles = [];
    function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && !full.includes('/generated/')) srcFiles.push(full);
      }
    }
    walk(join(root, 'src'));
    const allSrc = srcFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');

    const freight = [...slow, ...fast].filter((k) => !hasHydrationConsumer(allSrc, k));

    assert.deepEqual(
      freight,
      [],
      `these keys ride in a tier every client downloads but no client reads their hydration — move them to ON_DEMAND_KEYS: ${freight.join(', ')}`,
    );
  });

  it('keeps PENDING_CONSUMERS in sync with real hydration call sites', () => {
    const srcFiles = [];
    function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && !full.includes('/generated/')) srcFiles.push(full);
      }
    }
    walk(join(root, 'src'));
    const allSrc = srcFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');

    const stale = [...PENDING_CONSUMERS].filter((key) =>
      allSrc.includes(`getHydratedData('${key}')`) || allSrc.includes(`ensureHydrated('${key}')`));

    assert.deepEqual(
      stale,
      [],
      `PENDING_CONSUMERS entries have real hydration consumers and must be removed: ${stale.join(', ')}`,
    );
  });

  it('on-demand keys are NOT served by the tier bundles every client downloads', () => {
    const slow = tierKeys('slow');
    const fast = tierKeys('fast');
    const onDemand = tierKeys('on-demand');

    assert.ok(onDemand.has('cyberThreats'), 'cyberThreats must stay on-demand: its layer is off by default in every variant');
    assert.ok(!slow.has('cyberThreats') && !fast.has('cyberThreats'), 'cyberThreats must not ride in a tier');
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
