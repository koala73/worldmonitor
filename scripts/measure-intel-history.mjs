#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { getDocumentSize } from 'convex/values';
import { loadEnvFile } from './_seed-utils.mjs';
import { historyCostKey, HISTORY_COST_FIELDS } from './lib/intel-history-cost.mjs';
import { EMBED_MODEL } from './lib/brief-dedup-consts.mjs';

export async function measureHistoryStorage({ query, maxRows = 100000, now = Date.now }) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000000) {
    throw new Error('maxRows must be an integer between 1 and 1000000');
  }
  const startedAt = new Date(now()).toISOString();
  const scopes = new Map();
  let cursor = null;
  let complete = false;
  let rows = 0;
  while (!complete && rows < maxRows) {
    const result = await query('_system/cli/tableData', {
      table: 'intelHistory', order: 'asc',
      paginationOpts: { cursor, numItems: Math.min(500, maxRows - rows) },
    });
    if (!Array.isArray(result?.page) || typeof result.isDone !== 'boolean') throw new Error('invalid storage page');
    if (!result.isDone && result.page.length === 0) throw new Error('empty unfinished storage page');
    for (const row of result.page) {
      const key = JSON.stringify([row.domain, row.resource]);
      const scope = scopes.get(key) ?? {
        domain: row.domain, resource: row.resource, rows: 0, documentBytes: 0, rawVectorBytes: 0,
      };
      scope.rows += 1;
      scope.documentBytes += getDocumentSize(row);
      scope.rawVectorBytes += (row.embedding?.length ?? 0) * 8;
      scopes.set(key, scope);
      rows += 1;
    }
    complete = result.isDone;
    if (!complete && (!result.continueCursor || result.continueCursor === cursor)) throw new Error('storage cursor did not advance');
    cursor = result.continueCursor;
  }
  return {
    startedAt, finishedAt: new Date(now()).toISOString(), complete, rows, maxRows,
    scopes: [...scopes.values()], vectorIndexBilledBytes: null,
  };
}

export async function readHistoryCost({ domain, resource, day }, deps = {}) {
  if (!domain || !resource || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') ||
      !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) {
    throw new Error('domain, resource, and a valid UTC day are required');
  }
  const env = deps.env ?? process.env;
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) throw new Error('Upstash credentials required');
  const response = await (deps.fetchImpl ?? globalThis.fetch)(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-history-cost/1.0' },
    body: JSON.stringify(['HGETALL', historyCostKey(domain, resource, day)]),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`history cost read HTTP ${response.status}`);
  const body = await response.json();
  if (body?.error || !Array.isArray(body?.result) || body.result.length % 2 !== 0) throw new Error('invalid history cost response');
  const scope = { domain, resource, day, model: EMBED_MODEL };
  if (body.result.length === 0) return { ...scope, status: 'not_observed' };
  const counters = Object.create(null);
  for (let i = 0; i < body.result.length; i += 2) {
    const raw = body.result[i + 1];
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value) || value < 0) throw new Error('invalid history cost counter');
    counters[body.result[i]] = value;
  }
  return { ...scope, status: 'observed', counters,
    reportedUsageComplete: HISTORY_COST_FIELDS.every(field => counters[field] !== undefined) &&
      counters.unknownCostRequests === 0 && counters.unknownEmbeddingRuns === 0 };
}

async function main(argv) {
  if (argv.includes('--help')) {
    console.log('Usage: node scripts/measure-intel-history.mjs --storage [--max-rows 100000]\n' +
      '       node scripts/measure-intel-history.mjs --cost --domain energy --resource intelligence --day YYYY-MM-DD');
    return;
  }
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--storage' || flag === '--cost') options[flag.slice(2)] = true;
    else if (['--domain', '--resource', '--day', '--max-rows'].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      options[flag.slice(2)] = argv[++i];
    } else throw new Error(`invalid option ${flag}`);
  }
  if (Boolean(options.storage) === Boolean(options.cost)) throw new Error('choose --storage or --cost');
  loadEnvFile(import.meta.url, { only: ['CONVEX_URL', 'CONVEX_DEPLOY_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] });
  let result;
  if (options.storage) {
    if (!process.env.CONVEX_URL || !process.env.CONVEX_DEPLOY_KEY) throw new Error('CONVEX_URL and CONVEX_DEPLOY_KEY required');
    const client = new ConvexHttpClient(process.env.CONVEX_URL, { fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('User-Agent', 'worldmonitor-history-cost/1.0');
      return globalThis.fetch(url, { ...init, headers, signal: AbortSignal.timeout(15000) });
    } });
    client.setAdminAuth(process.env.CONVEX_DEPLOY_KEY);
    result = await measureHistoryStorage({ query: (name, args) => client.query(name, args),
      maxRows: options['max-rows'] === undefined ? 100000 : Number(options['max-rows']) });
    if (!result.complete) process.exitCode = 2;
  } else {
    result = await readHistoryCost(options);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
