#!/usr/bin/env node
/**
 * Sets watchPatterns on all Railway seed services so they only redeploy
 * when their actual source files change (not on blog/frontend pushes).
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
]);

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

  // 2. Check current watch patterns
  for (const svc of services) {
    const { service } = await gql(token, `
      query ($id: String!) {
        service(id: $id) {
          serviceInstances(first: 1) {
            edges { node { watchPatterns } }
          }
        }
      }
    `, { id: svc.id });

    const current = service.serviceInstances.edges[0]?.node?.watchPatterns || [];

    // Build expected watch patterns
    const scriptFile = `scripts/${svc.name}.mjs`;
    const patterns = [scriptFile, 'scripts/_seed-utils.mjs', 'scripts/package.json'];

    if (USES_SHARED_CONFIG.has(svc.name)) {
      patterns.push('scripts/shared/**', 'shared/**');
    }

    // Special cases
    if (svc.name === 'seed-iran-events') {
      patterns.push('scripts/data/iran-events-latest.json');
    }

    const currentStr = JSON.stringify(current.sort());
    const expectedStr = JSON.stringify([...patterns].sort());

    if (currentStr === expectedStr) {
      console.log(`  ${svc.name}: already correct`);
      continue;
    }

    console.log(`  ${svc.name}:`);
    console.log(`    current:  ${current.length ? current.join(', ') : '(none)'}`);
    console.log(`    setting:  ${patterns.join(', ')}`);

    if (DRY_RUN) {
      console.log(`    [DRY RUN] skipped\n`);
      continue;
    }

    // 3. Update via serviceInstanceUpdate
    await gql(token, `
      mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }
    `, {
      serviceId: svc.id,
      environmentId: ENV_ID,
      input: { watchPatterns: patterns },
    });

    console.log(`    updated!\n`);
  }

  console.log(`\nDone.${DRY_RUN ? ' (dry run, no changes made)' : ''}`);
}

main().catch(e => { console.error(e); process.exit(1); });
