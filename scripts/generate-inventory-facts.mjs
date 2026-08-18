#!/usr/bin/env node
/**
 * Generate volatile public inventory facts from authoritative registries.
 *
 * These outputs are intentionally gitignored. Install and build commands must
 * generate them before API, Railway, or static-product consumers run.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeStats } from './docs-stats.mjs';
import {
  buildSourceAttributionStats,
  isSourceAttributionManifestError,
} from './source-attribution.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Inventory facts are a boot artifact. A stale attribution ledger is a
 * `sources:check` / `docs:check` failure, not a reason to skip writing
 * `api/_inventory-facts.generated.js`.
 */
export function loadStatsForInventoryFacts({
  compute = computeStats,
  fallbackAttribution = () => buildSourceAttributionStats({ validate: false }),
  warn = console.warn,
} = {}) {
  try {
    return compute();
  } catch (error) {
    if (!isSourceAttributionManifestError(error)) throw error;
    const sourceAttribution = fallbackAttribution();
    warn(`inventory facts: proceeding with committed attribution counts; ${error.message}`);
    return compute({ sourceAttribution });
  }
}

export function buildInventoryFacts(stats = loadStatsForInventoryFacts()) {
  const capabilities = {
    mcpTools: stats.mcpToolCount,
    locales: stats.locales,
    variants: stats.variantCount,
    mapLayers: stats.layerDefinitions,
    panelImplementations: stats.panelClasses,
    feedDefinitions: stats.feedDefinitions,
    freshnessTrackedSourceGroups: stats.freshnessSources,
    sourceAttributionHosts: stats.sourceAttributionHosts,
    sourceAttributionProviders: stats.sourceAttribution.providerCount,
    localeCodes: stats.localeCodes,
  };

  for (const [name, value] of Object.entries(capabilities)) {
    if (name === 'localeCodes') continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`inventory capability ${name} must be a positive integer`);
    }
  }
  if (!Array.isArray(capabilities.localeCodes)
    || capabilities.localeCodes.length === 0
    || new Set(capabilities.localeCodes).size !== capabilities.localeCodes.length
    || capabilities.localeCodes.some((code) => typeof code !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(code))) {
    throw new Error('inventory capability localeCodes must be a non-empty unique locale-code registry');
  }
  if (capabilities.localeCodes.length !== capabilities.locales) {
    throw new Error('inventory capability localeCodes must match the derived locale count');
  }

  return {
    _generated: 'scripts/generate-inventory-facts.mjs — build artifact; do not commit',
    capabilities,
  };
}

function expectedInventoryOutputs({ loadStats = loadStatsForInventoryFacts } = {}) {
  const productFacts = readJson('shared/product-facts.generated.json');
  if ('capabilities' in productFacts) {
    throw new Error('shared/product-facts.generated.json must not contain extensible inventory counts');
  }

  const stats = loadStats();
  const inventoryFacts = buildInventoryFacts(stats);
  const publicFacts = { ...productFacts, capabilities: inventoryFacts.capabilities };
  const edgeModule = `// AUTO-GENERATED build artifact from authoritative registries.\n// Do not edit manually. Run: npm run inventory:facts\n// @ts-check\n\nexport const PUBLIC_INVENTORY_FACTS = ${JSON.stringify(inventoryFacts, null, 2)};\n`;

  return new Map([
    ['public/product-facts.json', json(publicFacts)],
    ['scripts/shared/inventory-facts.generated.json', json(inventoryFacts)],
    ['api/_inventory-facts.generated.js', edgeModule],
    ['docs/generated/stats.json', json(stats)],
  ]);
}

const DEFAULT_FILE_OPS = Object.freeze({ mkdirSync, renameSync, unlinkSync, writeFileSync });

function atomicWrite(rootDir, path, content, fileOps = DEFAULT_FILE_OPS) {
  const target = join(rootDir, path);
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fileOps.mkdirSync(dirname(target), { recursive: true });
    fileOps.writeFileSync(temporary, content, { flag: 'wx' });
    fileOps.renameSync(temporary, target);
  } catch (error) {
    try { fileOps.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function generateInventoryFacts({
  check = false,
  outputs,
  rootDir = ROOT,
  fileOps = DEFAULT_FILE_OPS,
  loadStats = loadStatsForInventoryFacts,
} = {}) {
  const expectedOutputs = outputs ?? expectedInventoryOutputs({ loadStats });
  // Prepare and validate every output before replacing any consumer artifact.
  const readCurrent = (path) => {
    try {
      return readFileSync(join(rootDir, path), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };
  if (check) {
    const stale = findStaleInventoryOutputs(expectedOutputs, readCurrent);
    if (stale.length > 0) {
      throw new Error(`inventory facts are missing or stale: ${stale.join(', ')}`);
    }
    return;
  }
  for (const [path, content] of expectedOutputs) {
    const current = readCurrent(path);
    if (current === content) continue;
    atomicWrite(rootDir, path, content, fileOps);
    console.log(`  ✓ ${join(rootDir, path)}`);
  }
}

function findStaleInventoryOutputs(outputs, readCurrent) {
  const stale = [];
  for (const [path, expected] of outputs) {
    if (readCurrent(path) !== expected) stale.push(path);
  }
  return stale;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    generateInventoryFacts({ check: process.argv.includes('--check') });
    if (process.argv.includes('--check')) console.log('inventory facts check OK');
  } catch (error) {
    console.error(`inventory facts check FAILED: ${error.message}`);
    process.exit(1);
  }
}
