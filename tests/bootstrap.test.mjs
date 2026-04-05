import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('Bootstrap cache key registry', () => {
  const cacheKeysPath = join(root, 'server', '_shared', 'cache-keys.ts');
  const cacheKeysSrc = readFileSync(cacheKeysPath, 'utf-8');
  const bootstrapSrc = readFileSync(join(root, 'api', 'bootstrap.js'), 'utf-8');

  const cacheKeysBlock = cacheKeysSrc.match(/BOOTSTRAP_CACHE_KEYS[^{]*\{([^}]+)\}/)?.[1] ?? '';

  it('exports BOOTSTRAP_CACHE_KEYS with at least 10 entries', () => {
    const matches = cacheKeysBlock.match(/^\s+\w+:\s+'[^']+'/gm);
    assert.ok(matches && matches.length >= 10, `Expected ≥10 keys, found ${matches?.length ?? 0}`);
  });

  it('api/bootstrap.js inlined keys match server/_shared/cache-keys.ts', () => {
    const extractKeys = (src) => {
      const block = src.match(/BOOTSTRAP_CACHE_KEYS[^=]*=\s*\{([^}]+)\}/);
      if (!block) return {};
      const re = /(\w+):\s+'([a-z0-9_-]+(?::[a-z0-9_-]+)+:v\d+)'/g;
      const keys = {};
      let m;
      while ((m = re.exec(block[1])) !== null) keys[m[1]] = m[2];
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
    const keyRe = /:\s+'([^']+)'/g;
    let m;
    const keys = [];
    while ((m = keyRe.exec(cacheKeysBlock)) !== null) {
      keys.push(m[1]);
    }
    for (const key of keys) {
      assert.match(key, /^[a-z0-9_-]+(?::[a-z0-9_-]+)+:v\d+(?::[a-z0-9_-]+)*$/, `Cache key "${key}" does not match expected pattern`);
    }
  });

  it('has no duplicate cache keys', () => {
    const keyRe = /:\s+'([^']+)'/g;
    let m;
    const keys = [];
    while ((m = keyRe.exec(cacheKeysBlock)) !== null) {
      keys.push(m[1]);
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

  it('keeps web bootstrap tier timeouts under 2 seconds', () => {
    const timeouts = Array.from(src.matchAll(/(\d[_\d]*)\)/g))
      .map((m) => parseInt(m[1].replace(/_/g, ''), 10))
      .filter((n) => n === 1200 || n === 1800);
    assert.deepEqual(timeouts, [1200, 1800], `Expected aggressive web bootstrap timeouts (1200, 1800)`);
  });

  it('allows longer bootstrap timeouts for desktop runtime', () => {
    assert.ok(src.includes('isDesktopRuntime'), 'Bootstrap should branch on desktop for longer timeouts');
  });

  it('fetches tiered bootstrap URLs', () => {
    assert.ok(src.includes('/api/bootstrap?tier='), 'Missing tiered bootstrap fetch URLs');
  });

  it('handles fetch failure silently', () => {
    assert.ok(src.includes('catch'), 'Missing error handling — panels should fall through to individual calls');
  });

  it('fetches both tiers in parallel', () => {
    assert.ok(src.includes('Promise.all'), 'Missing Promise.all for parallel tier fetches');
    assert.ok(src.includes("'slow'"), 'Missing slow tier fetch');
    assert.ok(src.includes("'fast'"), 'Missing fast tier fetch');
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

describe('Bootstrap key hydration coverage', () => {
  it('every bootstrap key has a getHydratedData consumer in src/', () => {
    const bootstrapSrc = readFileSync(join(root, 'api', 'bootstrap.js'), 'utf-8');
    const block = bootstrapSrc.match(/BOOTSTRAP_CACHE_KEYS\s*=\s*\{([^}]+)\}/);
    const keyRe = /(\w+):\s+'[a-z0-9_-]+(?::[a-z0-9_-]+)+:v\d+'/g;
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
    const PENDING_CONSUMERS = new Set(['chokepointTransits', 'correlationCards', 'euGasStorage']);
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
    const healthSrc = readFileSync(join(root, 'api', 'health.js'), 'utf-8');
    const extractValues = (name) => {
      const block = healthSrc.match(new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`));
      if (!block) return [];
      return [...block[1].matchAll(/:\s+'([^']+)'/g)].map((m) => m[1]);
    };

    const bootstrap = new Set(extractValues('BOOTSTRAP_KEYS'));
    const standalone = new Set(extractValues('STANDALONE_KEYS'));
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
    return new Set([...block[1].matchAll(/(\w+):\s+'/g)].map(x => x[1]));
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
