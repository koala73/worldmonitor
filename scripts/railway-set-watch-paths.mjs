#!/usr/bin/env node
/**
 * Sets watchPatterns, validates startCommand, and syncs cronSchedule on Railway seed services.
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
const REQUIRED_SEED_SERVICES = new Set(['seed-regulatory-actions']);
const EXPECTED_CRON_SCHEDULES = new Map([
  ['seed-regulatory-actions', '0 */2 * * *'],
]);

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

function buildExpectedPatterns(serviceName) {
  const scriptFile = `scripts/${serviceName}.mjs`;
  const patterns = [scriptFile, 'scripts/_seed-utils.mjs', 'scripts/package.json'];

  if (USES_SHARED_CONFIG.has(serviceName)) {
    patterns.push('scripts/shared/**', 'shared/**');
  }

  if (serviceName === 'seed-iran-events') {
    patterns.push('scripts/data/iran-events-latest.json');
  }

  return patterns;
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

  const missingRequiredServices = [...REQUIRED_SEED_SERVICES].filter(
    (name) => !services.some((service) => service.name === name)
  );
  if (missingRequiredServices.length > 0) {
    throw new Error(`Missing required seed service(s): ${missingRequiredServices.join(', ')}`);
  }

  console.log(`Found ${services.length} seed services\n`);

  // 2. Check each service's watchPatterns, startCommand, and cronSchedule
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
    const currentCronSchedule = instance.cronSchedule || '';

    // rootDirectory="scripts" so startCommand must NOT include the scripts/ prefix
    const expectedStartCmd = `node ${svc.name}.mjs`;
    const startCmdOk = currentStartCmd === expectedStartCmd;
    const expectedCronSchedule = EXPECTED_CRON_SCHEDULES.get(svc.name) || '';
    const hasExpectedCronSchedule = EXPECTED_CRON_SCHEDULES.has(svc.name);
    const cronScheduleOk = !hasExpectedCronSchedule || currentCronSchedule === expectedCronSchedule;

    // Build expected watch patterns (relative to git repo root)
    const patterns = buildExpectedPatterns(svc.name);
    const patternsOk = JSON.stringify(currentPatterns.sort()) === JSON.stringify([...patterns].sort());

    if (patternsOk && startCmdOk && cronScheduleOk) {
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
    if (hasExpectedCronSchedule && !cronScheduleOk) {
      console.log(`    cronSchedule current: ${currentCronSchedule || '(none)'}`);
      console.log(`    cronSchedule expected: ${expectedCronSchedule}`);
    }

    if (DRY_RUN) {
      console.log(`    [DRY RUN] skipped\n`);
      continue;
    }

    // Build update input with only changed fields
    const input = {};
    if (!patternsOk) input.watchPatterns = patterns;
    if (!startCmdOk) input.startCommand = expectedStartCmd;
    if (hasExpectedCronSchedule && !cronScheduleOk) input.cronSchedule = expectedCronSchedule;

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
