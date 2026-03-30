#!/usr/bin/env node
/**
 * Sets watchPatterns and validates startCommand on all Railway seed services.
 *
 * All seed services use rootDirectory="scripts", so the correct startCommand
 * is `node seed-<name>.mjs` (NOT `node scripts/seed-<name>.mjs` — that path
 * would double the scripts/ prefix and cause MODULE_NOT_FOUND at runtime).
 *
 * Usage: node scripts/railway-set-watch-paths.mjs [--dry-run]
 *
 * Requires: RAILWAY_TOKEN env var or ~/.railway/config.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const PROJECT_ID = '29419572-0b0d-437f-8e71-4fa68daf514f';
const ENV_ID = '91a05726-0b83-4d44-a33e-6aec94e58780';
const API = 'https://backboard.railway.app/graphql/v2';

// Seeds that use loadSharedConfig (depend on scripts/shared/*.json)
const USES_SHARED_CONFIG = new Set([
  'seed-commodity-quotes', 'seed-crypto-quotes', 'seed-etf-flows',
  'seed-gulf-quotes', 'seed-market-quotes', 'seed-stablecoin-markets',
  'seed-climate-disasters',
]);

const EXTRA_WATCH_PATTERNS = {
  'seed-climate-disasters': ['public/data/countries.geojson'],
};

function getToken() {
  if (process.env.RAILWAY_TOKEN) return process.env.RAILWAY_TOKEN;
  const cfgPath = join(homedir(), '.railway', 'config.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return cfg.token || cfg.user?.token;
  }
  throw new Error('No Railway token found. Set RAILWAY_TOKEN or run `railway login`.');
}

async function gql(token, query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function main() {
  const token = getToken();

  // 1. List all services
  const { project } = await gql(token, `
    query ($id: String!) {
      project(id: $id) {
        services { edges { node { id name } } }
      }
    }
  `, { id: PROJECT_ID });

  const services = project.services.edges
    .map(e => e.node)
    .filter(s => s.name.startsWith('seed-'));

  console.log(`Found ${services.length} seed services\n`);

  // 2. Check each service's watchPatterns and startCommand
  for (const svc of services) {
    const { service } = await gql(token, `
      query ($id: String!, $envId: String!) {
        service(id: $id) {
          serviceInstances(first: 1, environmentId: $envId) {
            edges { node { watchPatterns startCommand } }
          }
        }
      }
    `, { id: svc.id, envId: ENV_ID });

    const instance = service.serviceInstances.edges[0]?.node || {};
    const currentPatterns = instance.watchPatterns || [];
    const currentStartCmd = instance.startCommand || '';

    // rootDirectory="scripts" so startCommand must NOT include the scripts/ prefix
    const expectedStartCmd = `node ${svc.name}.mjs`;
    const startCmdOk = currentStartCmd === expectedStartCmd;

    // Build expected watch patterns (relative to git repo root)
    const scriptFile = `scripts/${svc.name}.mjs`;
    const patterns = [scriptFile, 'scripts/_seed-utils.mjs', 'scripts/package.json'];

    if (USES_SHARED_CONFIG.has(svc.name)) {
      patterns.push('scripts/shared/**', 'shared/**');
    }

    if (EXTRA_WATCH_PATTERNS[svc.name]) {
      patterns.push(...EXTRA_WATCH_PATTERNS[svc.name]);
    }

    if (svc.name === 'seed-iran-events') {
      patterns.push('scripts/data/iran-events-latest.json');
    }

    const patternsOk = JSON.stringify(currentPatterns.sort()) === JSON.stringify([...patterns].sort());

    if (patternsOk && startCmdOk) {
      console.log(`  ${svc.name}: already correct`);
      continue;
    }

    console.log(`  ${svc.name}:`);
    if (!startCmdOk) {
      console.log(`    startCommand current:  ${currentStartCmd || '(none)'}`);
      console.log(`    startCommand expected: ${expectedStartCmd}`);
    }
    if (!patternsOk) {
      console.log(`    watchPatterns current:  ${currentPatterns.length ? currentPatterns.join(', ') : '(none)'}`);
      console.log(`    watchPatterns setting:  ${patterns.join(', ')}`);
    }

    if (DRY_RUN) {
      console.log(`    [DRY RUN] skipped\n`);
      continue;
    }

    // Build update input with only changed fields
    const input = {};
    if (!patternsOk) input.watchPatterns = patterns;
    if (!startCmdOk) input.startCommand = expectedStartCmd;

    await gql(token, `
      mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }
    `, {
      serviceId: svc.id,
      environmentId: ENV_ID,
      input,
    });

    console.log(`    updated!\n`);
  }

  console.log(`\nDone.${DRY_RUN ? ' (dry run, no changes made)' : ''}`);
}

main().catch(e => { console.error(e); process.exit(1); });
