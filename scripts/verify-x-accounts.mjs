#!/usr/bin/env node
/**
 * Verify data/x-accounts.json against the official X API (#6654 follow-up).
 *
 * The registry was originally curated without API access. Six handles pointed
 * at accounts that do not exist, one at a suspended account, and four pinned
 * accountIds pointed at unrelated private individuals — whose posts would have
 * published into the intelligence feed as trusted tier-2 wire services and
 * reached the alert path. Nothing in CI could see it: the poll loop reported
 * only "6 errors" with no handle and no reason, and X answers an unreadable
 * account with HTTP 200 plus an `errors` body rather than a 4xx.
 *
 * Offline invariants (id present, well-formed, unique) are asserted by
 * tests/x-news-accounts.test.mjs. Only the API can prove an id still belongs to
 * the publisher we think it does, so that check lives here, out of CI, and is
 * run deliberately when the registry changes.
 *
 * Usage:
 *   X_BEARER_TOKEN=... node scripts/verify-x-accounts.mjs [--json] [--include-disabled]
 *
 * Cost: one User read per account (~$0.010, 24h-deduped). It does NOT read
 * timelines by default, so it does not bill post reads; pass --timelines to
 * additionally prove each timeline is actually readable.
 *
 * Exit 0 = every checked account verified. Exit 1 = at least one mismatch.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(__dirname, '../data/x-accounts.json');
const X_API_ORIGIN = 'https://api.x.com';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const includeDisabled = args.has('--include-disabled');
const checkTimelines = args.has('--timelines');

const token = process.env.X_BEARER_TOKEN;
if (!token) {
  console.error('X_BEARER_TOKEN is not set — cannot verify against the official API.');
  process.exit(2);
}

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const accounts = [];
for (const [group, arr] of Object.entries(registry.channels || {})) {
  for (const account of arr) {
    if (!account.enabled && !includeDisabled) continue;
    accounts.push({ ...account, group });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * X reports an unreadable resource with HTTP 200 and a top-level `errors`
 * array. Treating `response.ok` as success is precisely the bug this script
 * exists to catch, so read the payload, not the status.
 */
function resourceError(body) {
  if (body?.data) return null;
  const error = (Array.isArray(body?.errors) ? body.errors : [])[0];
  if (error) return `${error.title || 'API error'}${error.detail ? `: ${error.detail}` : ''}`;
  // A quiet account answers `{"meta":{"result_count":0}}` — no `data` key and
  // no `errors` key (verified against the live API). Reporting that as a fault
  // would flag every account that simply had nothing to say in the window.
  if (typeof body?.meta?.result_count === 'number') return null;
  return 'empty response with no data, no errors, and no result_count';
}

async function apiGet(path) {
  const response = await fetch(new URL(path, X_API_ORIGIN), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 429) {
    const reset = Number(response.headers.get('x-rate-limit-reset') || 0) * 1000;
    const waitMs = Math.max(5_000, reset - Date.now());
    process.stderr.write(`rate limited; waiting ${Math.round(waitMs / 1000)}s\n`);
    await sleep(waitMs);
    return apiGet(path);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const findings = [];
for (const account of accounts) {
  const handle = String(account.handle || '').replace(/^@/, '');
  const label = `@${handle}`;

  if (!account.accountId) {
    findings.push({ handle, level: 'error', kind: 'missing-id', message: 'no accountId pinned' });
    continue;
  }

  // Resolve BOTH directions: the id proves who we actually poll, the handle
  // proves the registry still names the same account. A rename breaks only the
  // handle; a bad copy-paste breaks only the id.
  const { status, body } = await apiGet(`/2/users/${account.accountId}?user.fields=id,name,username,protected`);
  const failure = resourceError(body);
  if (failure) {
    findings.push({ handle, level: 'error', kind: 'unresolvable-id', message: `id ${account.accountId} — ${failure} (HTTP ${status})` });
    await sleep(400);
    continue;
  }

  const actual = body.data;
  if (String(actual.username).toLowerCase() !== handle.toLowerCase()) {
    findings.push({
      handle,
      level: 'error',
      kind: 'handle-mismatch',
      message: `id ${account.accountId} is @${actual.username} (${actual.name}), not ${label}`,
    });
  }
  if (actual.protected) {
    findings.push({
      handle,
      level: 'error',
      kind: 'protected',
      message: `${label} is protected — X refuses its timeline to a third-party app; disable it or coverage never completes`,
    });
  }

  if (checkTimelines && !actual.protected) {
    const timeline = await apiGet(`/2/users/${account.accountId}/tweets?max_results=5&tweet.fields=id`);
    const timelineFailure = resourceError(timeline.body);
    if (timelineFailure) {
      findings.push({ handle, level: 'error', kind: 'unreadable-timeline', message: timelineFailure });
    }
    await sleep(400);
  }

  await sleep(400);
}

if (asJson) {
  console.log(JSON.stringify({ checked: accounts.length, findings }, null, 2));
} else {
  console.log(`checked ${accounts.length} account(s) against ${X_API_ORIGIN}`);
  if (findings.length === 0) {
    console.log('all verified — every accountId resolves to the handle the registry names');
  } else {
    for (const f of findings) {
      console.log(`  ${f.level.toUpperCase()} @${f.handle} [${f.kind}] ${f.message}`);
    }
    console.log(`\n${findings.length} finding(s). Update data/x-accounts.json and bump each entry's verifiedAt.`);
  }
}

process.exit(findings.length === 0 ? 0 : 1);
