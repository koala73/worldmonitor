import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { TOOL_REGISTRY } from '../api/mcp.ts';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');
const PUBLIC_SEED_KEY_RE = /(?:export\s+)?const\s+([A-Z0-9_]+)\s*=\s*'([^']+)'/g;
const MCP_VISIBLE_KEY_NAME_RE = /^(?:CANONICAL|BOOTSTRAP|HISTORICAL|ANALYSIS|PROGRESS|RENEWABLE)_KEY$|^[A-Z0-9_]*VULNERABILITY_KEY$|^(?:KEY|REDIS_KEY)$/;
const MCP_HEALTH_BRIDGE_KEYS = [
  {
    healthName: 'sharedFxRates',
    redisKey: 'shared:fx-rates:v1',
    metaKey: 'seed-meta:shared:fx-rates',
    seedDomain: 'shared:fx-rates',
  },
  {
    healthName: 'submarineCables',
    redisKey: 'infrastructure:submarine-cables:v1',
    metaKey: 'seed-meta:infrastructure:submarine-cables',
    seedDomain: 'infrastructure:submarine-cables',
  },
  {
    healthName: 'portwatchDisruptions',
    redisKey: 'portwatch:disruptions:active:v1',
    metaKey: 'seed-meta:portwatch:disruptions',
    seedDomain: 'portwatch:disruptions',
  },
  {
    healthName: 'defensePatents',
    redisKey: 'patents:defense:latest',
    metaKey: 'seed-meta:military:defense-patents',
    seedDomain: 'military:defense-patents',
  },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      out.push(...walk(file));
    } else {
      out.push(file);
    }
  }
  return out;
}

function collectSeedPublicKeys() {
  const entries = [];
  for (const file of walk(SCRIPTS_DIR).filter((path) => /seed-.*\.mjs$/.test(path))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(PUBLIC_SEED_KEY_RE)) {
      const [, name, key] = match;
      if (!MCP_VISIBLE_KEY_NAME_RE.test(name)) continue;
      entries.push({ key, file: relative(REPO_ROOT, file), name });
    }
  }
  return entries;
}

describe('MCP seed coverage', () => {
  it('exposes every MCP-visible seed key declared in scripts/seed-*.mjs', () => {
    const publicEntries = collectSeedPublicKeys();
    assert.ok(publicEntries.length >= 65, `expected >=65 MCP-visible seed keys, found ${publicEntries.length}`);

    for (const key of [
      'health:vpd-tracker:historical:v1',
      'intelligence:advisories-bootstrap:v1',
      'energy:oil-stocks-analysis:v1',
      'energy:lng-vulnerability:v1',
      'economic:worldbank-techreadiness:v1',
      'economic:worldbank-progress:v1',
      'economic:worldbank-renewable:v1',
    ]) {
      assert.ok(
        publicEntries.some((entry) => entry.key === key),
        `coverage scan missed public companion key ${key}`,
      );
    }

    const duplicates = publicEntries.filter(
      (entry, idx) => publicEntries.findIndex((candidate) => candidate.key === entry.key) !== idx,
    );
    assert.deepEqual(
      duplicates,
      [],
      `duplicate MCP-visible key declarations found: ${duplicates.map((entry) => `${entry.key} (${entry.file}:${entry.name})`).join(', ')}`,
    );

    const mcpCacheKeys = new Set(
      TOOL_REGISTRY.flatMap((tool) => ('_cacheKeys' in tool ? tool._cacheKeys : [])),
    );

    const missing = publicEntries.filter(({ key }) => !mcpCacheKeys.has(key));
    assert.deepEqual(
      missing,
      [],
      [
        'Every MCP-visible seed key must be exposed through `api/mcp.ts`.',
        'If a new seeder lands, add its public companion keys (for example CANONICAL_KEY / BOOTSTRAP_KEY / HISTORICAL_KEY / ANALYSIS_KEY) to an existing MCP tool or create a new one in `api/mcp.ts` in the same PR.',
        `Missing: ${missing.map((entry) => `${entry.key} (${entry.file}:${entry.name})`).join(', ')}`,
      ].join('\n'),
    );
  });

  it('tracks MCP-exposed seed keys in health and seed-health registries', () => {
    const healthSrc = readFileSync(join(REPO_ROOT, 'api/health.js'), 'utf8');
    const seedHealthSrc = readFileSync(join(REPO_ROOT, 'api/seed-health.js'), 'utf8');

    for (const { healthName, redisKey, metaKey, seedDomain } of MCP_HEALTH_BRIDGE_KEYS) {
      assert.match(
        healthSrc,
        new RegExp(`${escapeRegExp(healthName)}:\\s*'${escapeRegExp(redisKey)}'`),
        `api/health.js STANDALONE_KEYS missing ${healthName} -> ${redisKey}`,
      );
      assert.match(
        healthSrc,
        new RegExp(`${escapeRegExp(healthName)}:\\s*\\{[^}]*key:\\s*'${escapeRegExp(metaKey)}'`),
        `api/health.js SEED_META missing ${healthName} -> ${metaKey}`,
      );
      assert.match(
        seedHealthSrc,
        new RegExp(`'${escapeRegExp(seedDomain)}':\\s*\\{[^}]*key:\\s*'${escapeRegExp(metaKey)}'`),
        `api/seed-health.js SEED_DOMAINS missing ${seedDomain} -> ${metaKey}`,
      );
    }
  });
});
