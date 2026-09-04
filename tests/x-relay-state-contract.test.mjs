import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Importing scripts/ais-relay.cjs starts its server. Keep only relay wiring
// checks here; tests/x-poll-cycle.test.mjs executes the extracted cycle behavior.
const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const health = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
const healthDocs = readFileSync(new URL('../docs/health-endpoints.mdx', import.meta.url), 'utf8');
const railwayServices = JSON.parse(
  readFileSync(new URL('../scripts/railway-services.json', import.meta.url), 'utf8'),
);

function functionBody(name) {
  const start = relay.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  // Every function in this file is top-level, but most are `async function`.
  // Terminating only on `\nfunction ` made an async declaration invisible as an
  // end marker, so a body ran on through every async function that followed it
  // and any assertion here could be satisfied by code in a different function.
  // Stop at the next top-level declaration of either kind.
  const rest = relay.slice(start + 1);
  const offsets = ['\nfunction ', '\nasync function ']
    .map((marker) => rest.indexOf(marker))
    .filter((index) => index >= 0);
  const next = offsets.length ? Math.min(...offsets) : -1;
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe('X relay wiring contract', () => {
  it('builds the poll cycle with the real relay collaborators', () => {
    // The cycle must be constructed from this file's Redis helpers and state, or
    // the executable tests in x-poll-cycle.test.mjs would be exercising a module
    // production never actually wires up.
    assert.match(relay, /const \{ createXPollCycle, xPollSlot \} = require\('\.\/lib\/x-poll-cycle\.cjs'\)/);
    assert.match(relay, /createXPostBudget,[\s\S]*DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,[\s\S]*require\('\.\/lib\/x-post-budget\.cjs'\)/);
    assert.match(relay, /createXPostBudget\(\{[\s\S]*dailyCoveragePosts: DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,[\s\S]*\}\)/);
    assert.match(relay, /const xPollCycle = createXPollCycle\(\{/);
    for (const dep of [
      'xState', 'xNewsAccounts', 'xPostBudget', 'loadXAccounts',
      'upstashGet', 'upstashSetNx', 'upstashPublishXIfLockOwner', 'upstashReleaseLockIfOwner',
      'getPollGeneration', 'scheduleRetry',
      'X_CURATED_LIST_ID', 'X_POLL_INTERVAL_MS',
      'X_FEED_CACHE_KEY', 'X_FEED_POLL_STATE_KEY', 'X_FEED_POLL_LOCK_KEY', 'X_FEED_META_KEY',
    ]) {
      assert.match(relay, new RegExp(`\\n\\s+${dep}[,:]`), `cycle must receive ${dep}`);
    }
  });

  it('keeps budget data on the authenticated status route and out of the feed response', () => {
    const statusStart = relay.indexOf("pathname === '/status'");
    const metricsStart = relay.indexOf("pathname === '/metrics'", statusStart);
    assert.ok(statusStart >= 0 && metricsStart > statusStart, 'the authenticated /status route must exist');
    const statusRoute = relay.slice(statusStart, metricsStart);
    assert.match(statusRoute, /lastCycleUsage/);
    assert.match(statusRoute, /lastDeletionAuditAt/);
    assert.match(statusRoute, /postBudget/);
    assert.match(statusRoute, /xPostBudget\.status\(\{ requestedPosts: 5, coverageUnitPosts: 5 \}\)/);
    assert.match(statusRoute, /status: xPostBudgetServiceStatus\(postBudget\)/);
    assert.match(statusRoute, /lastAttemptAt/);
    assert.match(statusRoute, /lastProviderSuccessAt/);
    assert.match(statusRoute, /lastAcceptedPublicationAt/);
    assert.match(statusRoute, /lastAttemptSlot/);
    assert.match(statusRoute, /lastProviderSuccessSlot/);
    assert.match(statusRoute, /lastPublishedSlot/);
    assert.match(statusRoute, /bearerConfigured: Boolean\(X_BEARER_TOKEN\)/);

    const feedStart = relay.indexOf("pathname === '/x'");
    const rssStart = relay.indexOf("pathname.startsWith('/rss')", feedStart);
    assert.ok(feedStart >= 0 && rssStart > feedStart, 'the /x feed route must exist');
    const feedRoute = relay.slice(feedStart, rssStart);
    assert.doesNotMatch(feedRoute, /postBudget|lastCycleUsage|lastDeletionAuditAt|lastAttemptAt|lastProviderSuccessAt/);
  });

  it('hydrates once before scheduling the first poll', () => {
    const loop = functionBody('startXPollLoop');
    assert.match(loop, /await xPollCycle\.hydrate\(\)/);
    assert.match(loop, /xPollSlot\(Date\.now\(\), X_POLL_INTERVAL_MS\)/);
    assert.match(loop, /xState\.lastAttemptSlot === slot\.id/);
    // A restart must not step on a live 429 window either.
    assert.match(loop, /xState\.rateLimitedUntil/);
    assert.doesNotMatch(loop, /sourceState: 'unavailable'/);
  });

  it('retries a slot tick that collides with a still-running prior poll', () => {
    const loop = functionBody('startXPollLoop');
    assert.match(relay, /function guardedXPoll[\s\S]*return xPollGuard\.run/);
    assert.match(loop, /const started = guardedXPoll\(\)/);
    assert.match(loop, /const delayMs = started \? Math\.max\(1000, activeSlot\.endsAt - Date\.now\(\)\) : 1000/);
  });

  it('enables the List poller only when both X settings are present', () => {
    assert.match(relay, /const X_CURATED_LIST_ID = String\(process\.env\.X_CURATED_LIST_ID \|\| ''\)\.trim\(\)/);
    assert.match(relay, /const X_CURATED_LIST_CONFIGURED = \/\^\[1-9\]\\d\{0,18\}\$\/\.test\(X_CURATED_LIST_ID\)/);
    assert.match(relay, /const X_ENABLED = Boolean\(X_BEARER_TOKEN && X_CURATED_LIST_CONFIGURED\)/);
    assert.match(relay, /listConfigured: X_CURATED_LIST_CONFIGURED/);
    assert.match(functionBody('startXPollLoop'), /xState\.lastError = `X List poll disabled: missing \$\{missing\.join\(' and '\)\}`/);
    assert.doesNotMatch(relay, /X_CHANNEL_SET|X_POLL_INTERVAL_MS \|\|/);
  });

  it('requires both X settings before Railway deploys the relay', () => {
    const relayService = railwayServices.find((entry) => entry.service === 'ais-relay');
    assert.deepEqual(relayService?.requiredEnv, ['X_BEARER_TOKEN', 'X_CURATED_LIST_ID']);
  });

  it('requires both shared-budget services to cross the UTC cutover together', () => {
    const workerService = railwayServices.find((entry) => entry.service === 'company-monitoring-worker');
    assert.ok(workerService?.watchPatterns.includes('scripts/lib/x-post-budget.cjs'));
    assert.match(healthDocs, /Deploy both `ais-relay` and `company-monitoring-worker` from the new head/);
    assert.match(healthDocs, /all old instances of both services have exited before the boundary/);
  });

  it('keeps only aggregate List bookkeeping in relay state', () => {
    const start = relay.indexOf('const xState = {');
    const end = relay.indexOf('\n};', start);
    const state = relay.slice(start, end);
    assert.doesNotMatch(state, /cursorByAccountId|accountIdByHandle|lastPolledAtByHandle|accountOffset/);
    assert.match(state, /lastAttemptAt/);
    assert.match(state, /lastProviderSuccessAt/);
    assert.match(state, /lastAcceptedPublicationAt/);
  });

  it('fences the guard on its own counter, never the persisted snapshot version', () => {
    assert.match(relay, /createPollGenerationGuard/);
    assert.match(relay, /stuckAfterMs: X_POLL_STUCK_AFTER_MS/);

    // The guard's run counter must NOT be xState.generation. That field is the
    // persisted snapshot version, and hydrate() rewrites it from Redis in the
    // middle of a live poll (lease conflict, hydration retry) — which retired the
    // generation the guard was fencing on, so its `.finally` never cleared
    // inFlight and the next tick skipped a whole cycle.
    assert.match(relay, /let xPollGeneration = 0;/);
    assert.match(relay, /getGeneration: \(\) => xPollGeneration/);
    assert.match(relay, /setGeneration: \(generation\) => \{ xPollGeneration = generation; \}/);
    assert.doesNotMatch(relay, /getGeneration: \(\) => xState\.generation/);
    // The cycle reads the counter through an accessor, so it cannot reach the
    // module-level mutable and cannot be handed xState.generation by mistake.
    assert.match(relay, /getPollGeneration: \(\) => xPollGeneration/);

    // Both values must stay below the fixed cadence. This lets an expired owner
    // lease recover at the next slot, where the process guard also aborts a
    // locally stuck generation before starting its replacement.
    const leaseExpression = /const X_FEED_POLL_LOCK_TTL_SECONDS = ([^;]+);/.exec(relay);
    const stuckExpression = /const X_POLL_STUCK_AFTER_MS = ([^;]+);/.exec(relay);
    assert.ok(leaseExpression && stuckExpression, 'lease TTL and stuck threshold must both be named constants');
    const evaluate = (expression, intervalMs) => new Function('X_POLL_INTERVAL_MS', `return (${expression});`)(intervalMs);
    const stuckAfterMs = evaluate(stuckExpression[1], 15 * 60_000);
    const leaseMs = evaluate(leaseExpression[1], 15 * 60_000) * 1000;
    assert.ok(stuckAfterMs > 0 && stuckAfterMs < 15 * 60_000);
    assert.ok(leaseMs > 2 * 15_000 && leaseMs < 15 * 60_000);
  });

  it('lets RPC request tombstones while the first-party default hides them', () => {
    assert.match(relay, /includeDeleted = url\.searchParams\.get\('includeDeleted'\) === '1'/);
    assert.match(relay, /if \(!includeDeleted && it\.contentState === 'deleted'\) return false/);
  });

  it('keeps the public xFeed staleness budget at three fixed slots', () => {
    assert.match(health, /xFeed:\s+\{ key: 'seed-meta:intelligence:x-feed:v1', maxStaleMin: 45 \}/);
  });
});
