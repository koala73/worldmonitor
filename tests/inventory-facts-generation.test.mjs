// The generate-inventory-facts contract, split out of
// public-product-facts.test.mjs so it runs in the unit shards: nothing here
// reads built output, and the two full-tree fixtures below were most of that
// file's time in the unit-built-output job.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats } from '../scripts/docs-stats.mjs';
import { buildInventoryFacts, generateInventoryFacts, loadStatsForInventoryFacts } from '../scripts/generate-inventory-facts.mjs';
import { buildSourceAttributionStats, checkSourceAttribution } from '../scripts/source-attribution.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));

function makeInventoryFixture({ malformed = false } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-fixture-'));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  for (const path of tracked.split('\0').filter(Boolean)) {
    mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
    cpSync(join(ROOT, path), join(fixtureRoot, path), { recursive: true, verbatimSymlinks: true });
  }
  const manifest = readJson('shared/source-attribution-manifest.json');
  const entry = manifest.entries.find((row) => row.observed && row.kind === 'structured');
  assert.ok(entry, 'fixture needs an observed structured source');
  entry.references = [{ path: 'scripts/stale-source.mjs' }];
  if (malformed) entry.kind = 'not-a-source-kind';
  writeFileSync(join(fixtureRoot, 'shared/source-attribution-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return fixtureRoot;
}

function runInventoryFixture(fixtureRoot, script = 'scripts/generate-inventory-facts.mjs', args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
}

describe('inventory facts generation contract', () => {
  it('fails closed when any published inventory extractor collapses to zero', () => {
    const stats = computeStats();
    const capabilityStatKeys = [
      'mcpToolCount',
      'locales',
      'variantCount',
      'layerDefinitions',
      'panelClasses',
      'feedDefinitions',
      'freshnessSources',
      'sourceAttributionHosts',
    ];
    for (const key of capabilityStatKeys) {
      assert.throws(
        () => buildInventoryFacts({ ...stats, [key]: 0 }),
        /must be a positive integer/,
        `${key} parser collapse must fail generation`,
      );
    }
    assert.throws(
      () => buildInventoryFacts({
        ...stats,
        sourceAttribution: { ...stats.sourceAttribution, providerCount: 0 },
      }),
      /must be a positive integer/,
      'provider parser collapse must fail generation',
    );
    assert.throws(
      () => buildInventoryFacts({ ...stats, localeCodes: [] }),
      /localeCodes must be a non-empty unique locale-code registry/,
      'locale membership extraction must not collapse while its count stays positive',
    );
  });

  it('fails the inventory check for missing or stale build outputs', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-facts-'));
    mkdirSync(join(tempRoot, 'api'));
    mkdirSync(join(tempRoot, 'public'));
    const expected = new Map([
      ['api/_inventory-facts.generated.js', 'edge'],
      ['public/product-facts.json', 'public'],
    ]);
    try {
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /missing or stale: api\/_inventory-facts\.generated\.js, public\/product-facts\.json/,
      );
      generateInventoryFacts({ outputs: expected, rootDir: tempRoot });
      assert.doesNotThrow(() => (
        generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot })
      ));
      writeFileSync(join(tempRoot, 'api/_inventory-facts.generated.js'), 'stale');
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /missing or stale: api\/_inventory-facts\.generated\.js/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('stops consumers on an interrupted publication and repairs it on the next run', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-facts-interrupted-'));
    mkdirSync(join(tempRoot, 'api'));
    mkdirSync(join(tempRoot, 'public'));
    const expected = new Map([
      ['api/_inventory-facts.generated.js', 'edge'],
      ['public/product-facts.json', 'public'],
    ]);
    let renames = 0;
    let consumerRan = false;
    const interruptedFileOps = {
      mkdirSync,
      writeFileSync,
      unlinkSync,
      renameSync(from, to) {
        renames += 1;
        if (renames === 2) throw new Error('simulated publication interruption');
        renameSync(from, to);
      },
    };
    try {
      assert.throws(() => {
        generateInventoryFacts({ outputs: expected, rootDir: tempRoot, fileOps: interruptedFileOps });
        consumerRan = true;
      }, /simulated publication interruption/);
      assert.equal(consumerRan, false, 'a failed generator must stop the next consumer command');
      assert.equal(readFileSync(join(tempRoot, 'api/_inventory-facts.generated.js'), 'utf8'), 'edge');
      assert.equal(existsSync(join(tempRoot, `public/product-facts.json.tmp-${process.pid}`)), false);
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /public\/product-facts\.json/,
      );
      generateInventoryFacts({ outputs: expected, rootDir: tempRoot });
      assert.doesNotThrow(() => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('publishes all default inventory outputs from a stale but structurally valid attribution ledger', () => {
    const fixtureRoot = makeInventoryFixture();
    try {
      const strict = checkSourceAttribution(fixtureRoot);
      assert.ok(strict.errors.length > 0, 'strict source attribution checking must remain red for parity drift');
      assert.match(strict.errors.join('\n'), /stale manifest entry/);

      const result = runInventoryFixture(fixtureRoot);
      assert.equal(result.status, 0, result.stderr);
      const outputs = [
        'public/product-facts.json',
        'scripts/shared/inventory-facts.generated.json',
        'api/_inventory-facts.generated.js',
        'docs/generated/stats.json',
      ];
      const original = outputs.map((path) => readFileSync(join(fixtureRoot, path), 'utf8'));
      const publicFacts = JSON.parse(original[0]);
      const relayFacts = JSON.parse(original[1]);
      const stats = JSON.parse(original[3]);
      assert.deepEqual(publicFacts.capabilities, relayFacts.capabilities);
      assert.equal(publicFacts.capabilities.sourceAttributionHosts, stats.sourceAttributionHosts);
      assert.equal(stats.sourceAttributionHosts, buildSourceAttributionStats({ rootDir: fixtureRoot, validate: false }).activeHosts);
      const edge = runInventoryFixture(fixtureRoot, '--input-type=module', ['-e',
        "import { PUBLIC_INVENTORY_FACTS } from './api/_inventory-facts.generated.js'; console.log(JSON.stringify(PUBLIC_INVENTORY_FACTS));",
      ]);
      assert.equal(edge.status, 0, edge.stderr);
      assert.deepEqual(JSON.parse(edge.stdout), relayFacts);
      assert.match(result.stderr, /proceeding with committed attribution counts/);
      for (const args of [[], ['--check']]) {
        const replay = runInventoryFixture(fixtureRoot, 'scripts/generate-inventory-facts.mjs', args);
        assert.equal(replay.status, 0, replay.stderr);
        assert.deepEqual(outputs.map((path) => readFileSync(join(fixtureRoot, path), 'utf8')), original);
      }
      const strictCli = runInventoryFixture(fixtureRoot, 'scripts/source-attribution.mjs', ['--check']);
      assert.notEqual(strictCli.status, 0, 'bootstrap must not weaken the strict attribution gate');
      assert.match(strictCli.stderr + strictCli.stdout, /stale manifest entry/);

      writeFileSync(join(fixtureRoot, 'src/config/finance-geo.ts'), 'export const UNRELATED = [];\n');
      const brokenInventory = runInventoryFixture(fixtureRoot);
      assert.notEqual(brokenInventory.status, 0);
      assert.match(brokenInventory.stderr, /could not isolate STOCK_EXCHANGES/);
      assert.deepEqual(outputs.map((path) => readFileSync(join(fixtureRoot, path), 'utf8')), original);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('does not swallow non-attribution inventory failures', () => {
    assert.throws(
      () => loadStatsForInventoryFacts({
        compute: () => {
          throw new Error('docs-stats: could not isolate STOCK_EXCHANGES block');
        },
      }),
      /STOCK_EXCHANGES/,
    );
  });

  it('does not publish inventory outputs from a malformed attribution ledger', () => {
    const fixtureRoot = makeInventoryFixture({ malformed: true });
    try {
      const strict = checkSourceAttribution(fixtureRoot);
      assert.ok(strict.errors.length > 0, 'strict source attribution checking must reject malformed ledger entries');
      assert.match(strict.errors.join('\n'), /invalid manifest kind/);

      const result = runInventoryFixture(fixtureRoot);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid manifest kind/);
      for (const path of [
        'public/product-facts.json',
        'scripts/shared/inventory-facts.generated.json',
        'api/_inventory-facts.generated.js',
        'docs/generated/stats.json',
      ]) {
        assert.equal(existsSync(join(fixtureRoot, path)), false, `malformed ledger published ${path}`);
      }
      assert.doesNotMatch(result.stderr, /proceeding with committed attribution counts/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
