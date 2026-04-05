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

const SERVICE_OVERRIDES = {
  'seed-resilience-static': {
    watchPatterns: [
      'scripts/seed-resilience-static.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/_country-resolver.mjs',
      'scripts/package.json',
      'shared/**',
      'scripts/shared/**',
      'public/data/countries.geojson',
    ],
    startCommand: 'node seed-resilience-static.mjs',
    cronSchedule: '0 */4 1-3 10 *',
  },
  'seed-owid-energy-mix': {
    watchPatterns: [
      'scripts/seed-owid-energy-mix.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/_country-resolver.mjs',
      'scripts/package.json',
    ],
    startCommand: 'node seed-owid-energy-mix.mjs',
    cronSchedule: '0 3 1 * *', // 03:00 UTC on the 1st of every month
  },
  'seed-electricity-prices': {
    watchPatterns: [
      'scripts/seed-electricity-prices.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/package.json',
    ],
    startCommand: 'node seed-electricity-prices.mjs',
    cronSchedule: '0 14 * * *',
  },
  'seed-regulatory-actions': {
    watchPatterns: [
      'scripts/seed-regulatory-actions.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/package.json',
    ],
    startCommand: 'node seed-regulatory-actions.mjs',
    cronSchedule: '0 */2 * * *',
  },
  'seed-gas-storage-countries': {
    watchPatterns: [
      'scripts/seed-gas-storage-countries.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/package.json',
    ],
    startCommand: 'node seed-gas-storage-countries.mjs',
    cronSchedule: '30 10 * * *',
  },
  'seed-energy-intelligence': {
    watchPatterns: [
      'scripts/seed-energy-intelligence.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/package.json',
    ],
    startCommand: 'node seed-energy-intelligence.mjs',
    cronSchedule: '0 */6 * * *',
  },
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

export function buildExpectedServiceConfig(serviceName) {
  const override = SERVICE_OVERRIDES[serviceName];
  if (override) return { ...override };

  const config = {
    watchPatterns: [`scripts/${serviceName}.mjs`, 'scripts/_seed-utils.mjs', 'scripts/package.json'],
    startCommand: `node ${serviceName}.mjs`,
  };

  if (USES_SHARED_CONFIG.has(serviceName)) {
    config.watchPatterns.push('scripts/shared/**', 'shared/**');
  }

  if (serviceName === 'seed-iran-events') {
    config.watchPatterns.push('scripts/data/iran-events-latest.json');
  }

  if (serviceName === 'seed-climate-disasters') {
    config.watchPatterns.push('public/data/countries.geojson');
  }

  return config;
}

export function sameMembers(left = [], right = []) {
  if (left.length !== right.length) return false;
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
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
            edges { node { watchPatterns startCommand cronSchedule } }
          }
        }
      }
    `, { id: svc.id, envId: ENV_ID });

    const instance = service.serviceInstances.edges[0]?.node || {};
    const currentPatterns = instance.watchPatterns || [];
    const currentStartCmd = instance.startCommand || '';
    const currentCron = instance.cronSchedule || '';

    const expected = buildExpectedServiceConfig(svc.name);
    const startCmdOk = currentStartCmd === expected.startCommand;
    const patternsOk = sameMembers(currentPatterns, expected.watchPatterns);
    const cronOk = expected.cronSchedule ? currentCron === expected.cronSchedule : true;

    if (patternsOk && startCmdOk && cronOk) {
      console.log(`  ${svc.name}: already correct`);
      continue;
    }

    console.log(`  ${svc.name}:`);
    if (!startCmdOk) {
      console.log(`    startCommand current:  ${currentStartCmd || '(none)'}`);
      console.log(`    startCommand expected: ${expected.startCommand}`);
    }
    if (!patternsOk) {
      console.log(`    watchPatterns current:  ${currentPatterns.length ? currentPatterns.join(', ') : '(none)'}`);
      console.log(`    watchPatterns setting:  ${expected.watchPatterns.join(', ')}`);
    }
    if (!cronOk) {
      console.log(`    cronSchedule current:  ${currentCron || '(none)'}`);
      console.log(`    cronSchedule expected: ${expected.cronSchedule}`);
    }

    if (DRY_RUN) {
      console.log(`    [DRY RUN] skipped\n`);
      continue;
    }

    // Build update input with only changed fields
    const input = {};
    if (!patternsOk) input.watchPatterns = expected.watchPatterns;
    if (!startCmdOk) input.startCommand = expected.startCommand;
    if (!cronOk && expected.cronSchedule) input.cronSchedule = expected.cronSchedule;

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

if (process.argv[1]?.endsWith('railway-set-watch-paths.mjs')) {
  main().catch(e => { console.error(e); process.exit(1); });
}
