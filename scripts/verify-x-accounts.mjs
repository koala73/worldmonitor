#!/usr/bin/env node
/**
 * Verify that the configured public X List exactly mirrors data/x-accounts.json.
 *
 * Usage:
 *   X_BEARER_TOKEN=... X_CURATED_LIST_ID=... node scripts/verify-x-accounts.mjs [--json]
 *
 * This check reads one List object and one page of at most 100 User objects. It
 * never calls a Post-returning endpoint. Exit 0 means the List is public,
 * readable, unpaginated, and contains exactly the enabled immutable IDs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import xNewsAccounts from './lib/x-news-accounts.cjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(__dirname, '../data/x-accounts.json');
const X_API_ORIGIN = 'https://api.x.com';
const USER_AGENT = 'WorldMonitor-X-List-Verifier/1.0';
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export async function apiGet(path, token, fetchImpl = fetch, options = {}) {
  const now = options.now ?? Date.now;
  const sleepImpl = options.sleepImpl ?? sleep;
  const onRateLimit = options.onRateLimit ?? ((message) => process.stderr.write(message));
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const url = new URL(path, X_API_ORIGIN);
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const reset = Number(response.headers.get('x-rate-limit-reset') || 0) * 1000;
      const waitMs = Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(5_000, reset - now()));
      onRateLimit(`rate limited; waiting ${Math.round(waitMs / 1000)}s\n`);
      await sleepImpl(waitMs);
      continue;
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, ok: response.ok, body };
  }
  throw new Error('unreachable X verifier retry state');
}

function enabledRegistryAccounts(registry) {
  return Object.values(registry?.channels || {})
    .flat()
    .filter((account) => account?.enabled !== false);
}

async function main() {
  const asJson = process.argv.slice(2).includes('--json');
  const token = String(process.env.X_BEARER_TOKEN || '').trim();
  const listId = String(process.env.X_CURATED_LIST_ID || '').trim();
  if (!token || !/^[1-9]\d{0,18}$/.test(listId)) {
    console.error('X_BEARER_TOKEN and a numeric X_CURATED_LIST_ID are required.');
    return 2;
  }

  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const accounts = enabledRegistryAccounts(registry);
  const listPath = `/2/lists/${listId}?list.fields=id,name,description,private,member_count`;
  const membersPath = `/2/lists/${listId}/members?max_results=100&user.fields=id,name,username,protected`;
  const [listResult, membersResult] = await Promise.all([
    apiGet(listPath, token),
    apiGet(membersPath, token),
  ]);
  const result = xNewsAccounts.verifyXListMembership({
    listId,
    accounts,
    listBody: listResult.body,
    membersBody: membersResult.body,
  });
  if (!listResult.ok) {
    result.findings.unshift({ kind: 'list-http-error', message: `List lookup returned HTTP ${listResult.status}` });
    result.ok = false;
  }
  if (!membersResult.ok) {
    result.findings.unshift({ kind: 'members-http-error', message: `List members lookup returned HTTP ${membersResult.status}` });
    result.ok = false;
  }

  if (asJson) {
    console.log(JSON.stringify({ listId, ...result }, null, 2));
  } else {
    console.log(`checked public X List ${listId}: ${result.actualCount}/${result.expectedCount} member rows`);
    if (result.ok) {
      console.log('all verified — List membership exactly matches the enabled registry IDs');
    } else {
      for (const finding of result.findings) {
        console.log(`  ERROR [${finding.kind}] ${finding.message}`);
      }
    }
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
