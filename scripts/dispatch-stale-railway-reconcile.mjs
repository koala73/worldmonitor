#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { isMainModule } from './lib/main-module.mjs';
import { RailwayReconcileControlClient } from './railway-reconcile-control-client.mjs';

export const ACCEPTED_FRESHNESS_MS = 60 * 60_000;
export const PRE_MUTATION_ACTIVE_MS = 20 * 60_000;
export const POST_MUTATION_ACTIVE_MS = 45 * 60_000;
export const GITHUB_API_VERSION = '2026-03-10';
export const GITHUB_WATCHDOG_USER_AGENT = 'worldmonitor-railway-reconcile-watchdog/1';
export const TARGET_WORKFLOW_FILE = 'railway-deploy-trigger.yml';
export const GITHUB_PAGE_SIZE = 100;
export const WATCHDOG_HISTORY_WINDOW_MS = 24 * 60 * 60_000;
export const WATCHDOG_MAX_PAGES = 10;
export const WATCHDOG_MAX_API_REQUESTS = 250;
export const WATCHDOG_REQUEST_TIMEOUT_MS = 10_000;
export const WATCHDOG_READ_RETRY_ATTEMPTS = 2;
export const WATCHDOG_READ_RETRY_BASE_MS = 500;
export const WATCHDOG_READ_RETRY_MAX_MS = 8_000;
export const WATCHDOG_JOB_READ_CONCURRENCY = 6;
export const DISPATCH_CORRELATION_ATTEMPTS = 3;
export const DISPATCH_CORRELATION_POLL_MS = 1_000;
export const WATCHDOG_SOURCE_WORKFLOW_FILE = 'railway-deploy-trigger-watchdog.yml';
// The workflow records a named diagnostic step whenever the manual classifier
// fails closed on unreadable GitHub state.
export const WATCHDOG_READ_FAILURE_STEP_NAME = 'Record watchdog read-path failure';
export const MANUAL_RECOVERY_SOURCE_WORKFLOW_FILE = 'railway-reconcile-manual-recovery.yml';
export const WATCHDOG_DISPATCH_JOB_NAME = 'Dispatch authorized recovery';
export const WATCHDOG_DISPATCH_STEP_NAME = 'Dispatch exact Railway deploy-trigger run';
export const MANUAL_RECOVERY_DISPATCH_JOB_NAME = 'Dispatch ordinary lease-aware retry';
export const MANUAL_RECOVERY_DISPATCH_STEP_NAME = 'Dispatch correlated superseding generation';
export const PRE_DISPATCH_REJECTION_STEP_NAME = 'Record definitive pre-dispatch rejection';
export const GITHUB_DISPATCH_REJECTION_STEP_NAME = 'Record definitive GitHub dispatch rejection';

export const FINAL_ACCEPTANCE_STEP_NAME = 'Finalize exact Railway reconciliation acceptance';
export const MUTATION_STARTED_STEP_NAME = 'Mark Railway mutation started';
export const MANUAL_REQUIRED_STEP_NAME = 'Record manual-required reconciliation state';

export const WATCHDOG_OUTCOMES = Object.freeze([
  'HEALTHY',
  'WAITING_FOR_ACTIVE_RUN',
  'RECOVERY_AUTHORIZED',
  'RECOVERY_DISPATCHED',
  'RECOVERY_ELIGIBLE_OBSERVE_ONLY',
  'DEFERRED_NON_GREEN_MAIN',
  'DEFERRED_AMBIGUOUS',
  'MANUAL_REQUIRED_AFTER_MUTATION',
]);

const ACTIVE_RUN_STATES = Object.freeze(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const TERMINAL_GATE_STATES = Object.freeze(['success', 'failure', 'error', 'pending']);
const TERMINAL_RUN_CONCLUSIONS = Object.freeze([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
]);
const SOURCE_WORKFLOW_SPECS = Object.freeze([
  Object.freeze({
    workflowFile: WATCHDOG_SOURCE_WORKFLOW_FILE,
    events: Object.freeze(['schedule', 'workflow_dispatch']),
    dispatchJobName: WATCHDOG_DISPATCH_JOB_NAME,
    dispatchStepName: WATCHDOG_DISPATCH_STEP_NAME,
  }),
  Object.freeze({
    workflowFile: MANUAL_RECOVERY_SOURCE_WORKFLOW_FILE,
    events: Object.freeze(['workflow_dispatch']),
    dispatchJobName: MANUAL_RECOVERY_DISPATCH_JOB_NAME,
    dispatchStepName: MANUAL_RECOVERY_DISPATCH_STEP_NAME,
  }),
]);

export class GitHubWatchdogError extends Error {
  constructor(code, message, {
    status = null,
    ambiguous = false,
    retryAfterMs = null,
    cause = undefined,
  } = {}) {
    super(message, { cause });
    this.name = 'GitHubWatchdogError';
    this.code = code;
    this.status = status;
    this.ambiguous = ambiguous;
    this.retryAfterMs = retryAfterMs;
  }
}

// GitHub answers a secondary-rate-limit or abuse throttle with 403, and a
// concurrent-update race with 409. Both are transient despite being 4xx, which
// is why the dispatch path already refuses to call them definitive. Reads use
// the same predicate so the two paths cannot drift apart.
function isRetryableGitHubStatus(status) {
  return [403, 408, 409, 429].includes(status) || (status >= 500 && status < 600);
}

// Only a GitHub read failure marks the run blind. A control-plane outage or an
// ambiguous classification is a different tier that stays warning-green.
function readFailureCodeOf(error) {
  return error instanceof GitHubWatchdogError && error.code.startsWith('GITHUB_READ_')
    ? error.code
    : null;
}

// Exactly-once dispatch is guarded twice, on purpose. This is the outer guard:
// a POST gets one attempt whatever the error classifier later decides, so a
// future retryable POST classification cannot quietly turn into a second
// Railway deploy. `isRetryableRead` below is the inner one. Exported because a
// guard whose only proof is a second guard is a guard nobody can test.
export function retryAttemptsFor(method, readRetryAttempts) {
  return method === 'GET' ? readRetryAttempts + 1 : 1;
}

// A read worth retrying either never reached GitHub or came back on a
// transient status. Budget exhaustion and allowlist rejection are terminal by
// construction, and a malformed 2xx body is a contract break rather than a
// throttle — retrying any of those only burns the remaining budget.
function isRetryableRead(error) {
  if (!(error instanceof GitHubWatchdogError)) return false;
  // GITHUB_READ_TIMEOUT is deliberately absent. Every attempt burns the full
  // request timeout, and the snapshot issues ~90 reads six at a time, so a
  // retried timeout ladder would spend the classify job's own budget waiting on
  // an origin that already proved it is not answering.
  if (error.code !== 'GITHUB_READ_FAILED') return false;
  return error.status === null || isRetryableGitHubStatus(error.status);
}

function exactQuery(url, expected) {
  const actual = [...url.searchParams.entries()];
  return actual.length === Object.keys(expected).length
    && actual.every(([key, value]) => expected[key] === value);
}

function parseNextLink(value) {
  if (!value) return null;
  for (const part of value.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part);
    if (match?.[2] === 'next') return match[1];
  }
  return null;
}

function validIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function validGitHubId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validGitHubRunId(value) {
  return validGitHubId(value) || (typeof value === 'string' && /^[1-9][0-9]{0,23}$/.test(value));
}

function displayTitleHasIdentifier(displayTitle, identifier) {
  return String(displayTitle).split(/\s+/).includes(identifier);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export class GitHubWatchdogClient {
  constructor({
    repository,
    token,
    fetchImpl = (...args) => globalThis.fetch(...args),
    apiBase = 'https://api.github.com',
    now = Date.now,
    maxRequests = WATCHDOG_MAX_API_REQUESTS,
    requestTimeoutMs = WATCHDOG_REQUEST_TIMEOUT_MS,
    readRetryAttempts = WATCHDOG_READ_RETRY_ATTEMPTS,
    sleep = defaultSleep,
    random = Math.random,
  }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
      throw new TypeError('repository must be owner/name');
    }
    if (typeof token !== 'string' || token.length < 1) throw new TypeError('GitHub token is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > WATCHDOG_MAX_API_REQUESTS) {
      throw new TypeError(`GitHub request budget must be an integer from 1 to ${WATCHDOG_MAX_API_REQUESTS}`);
    }
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
      throw new TypeError('GitHub request timeout must be an integer from 1 to 30000ms');
    }
    if (!Number.isInteger(readRetryAttempts)
      || readRetryAttempts < 0
      || readRetryAttempts > WATCHDOG_READ_RETRY_ATTEMPTS) {
      throw new TypeError(`GitHub read retries must be an integer from 0 to ${WATCHDOG_READ_RETRY_ATTEMPTS}`);
    }
    if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
    if (typeof random !== 'function') throw new TypeError('random must be a function');
    const base = new URL(apiBase);
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/') {
      throw new TypeError('GitHub API base must be one credential-free HTTPS origin');
    }
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.maxRequests = maxRequests;
    this.requestCount = 0;
    this.requestTimeoutMs = requestTimeoutMs;
    this.readRetryAttempts = readRetryAttempts;
    this.sleep = sleep;
    this.random = random;
    this.apiBase = base.origin;
    this.repoPath = `/repos/${repository}`;
    this.repoPathPattern = this.repoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  #authorize(method, url, body) {
    if (url.origin !== this.apiBase || url.username || url.password || url.hash) return false;
    const page = url.searchParams.get('page');
    const paginated = page !== null && /^[1-9]\d*$/.test(page);
    if (method === 'GET' && url.pathname === `${this.repoPath}/git/ref/heads/main`) {
      return url.search === '';
    }
    if (method === 'GET' && new RegExp(`^${this.repoPathPattern}/commits/[0-9a-f]{40}/statuses$`, 'i').test(url.pathname)) {
      return paginated && exactQuery(url, { per_page: String(GITHUB_PAGE_SIZE), page });
    }
    if (method === 'GET' && url.pathname === `${this.repoPath}/actions/workflows/${TARGET_WORKFLOW_FILE}/runs`) {
      const created = url.searchParams.get('created');
      const status = url.searchParams.get('status');
      return paginated && (
        (/^>=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(created ?? '')
          && exactQuery(url, {
            created,
            filter: 'all',
            per_page: String(GITHUB_PAGE_SIZE),
            page,
          }))
        || (ACTIVE_RUN_STATES.includes(status)
          && exactQuery(url, {
            status,
            filter: 'all',
            per_page: String(GITHUB_PAGE_SIZE),
            page,
          }))
      );
    }
    if (method === 'GET' && new RegExp(`^${this.repoPathPattern}/actions/runs/\\d+/attempts/\\d+/jobs$`).test(url.pathname)) {
      return paginated && exactQuery(url, { per_page: String(GITHUB_PAGE_SIZE), page });
    }
    if (method === 'GET' && new RegExp(`^${this.repoPathPattern}/actions/runs/\\d+/attempts/\\d+$`).test(url.pathname)) {
      return url.search === '';
    }
    if (method === 'POST' && url.pathname === `${this.repoPath}/actions/workflows/${TARGET_WORKFLOW_FILE}/dispatches`) {
      return url.search === ''
        && body?.ref === 'main'
        && body?.return_run_details === true
        && Object.keys(body).sort().join(',') === 'inputs,ref,return_run_details'
        && validIdentifier(body.inputs?.recovery_attempt_id)
        && /^[0-9a-f]{40}$/i.test(body.inputs?.expected_head_sha ?? '')
        && Object.keys(body.inputs).sort().join(',') === 'expected_head_sha,recovery_attempt_id';
    }
    return false;
  }

  // Only reads retry. A dispatch POST may already have created a run, so a
  // resend would be a second Railway deploy: its transient statuses stay
  // GITHUB_DISPATCH_AMBIGUOUS and the durable hold decides, never a resend.
  // See retryAttemptsFor for why that rule is enforced in two places.
  async request(method, path, { body = undefined } = {}) {
    const url = new URL(path, this.apiBase);
    if (!this.#authorize(method, url, body)) {
      throw new GitHubWatchdogError(
        'GITHUB_ENDPOINT_FORBIDDEN',
        `${method} ${url.pathname} is outside the watchdog allowlist`,
      );
    }
    const attempts = retryAttemptsFor(method, this.readRetryAttempts);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#requestOnce(method, url, body);
      } catch (error) {
        if (attempt >= attempts - 1 || !isRetryableRead(error)) throw error;
        await this.sleep(this.#retryDelayMs(attempt, error));
      }
    }
  }

  #retryDelayMs(attempt, error) {
    if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
      // A secondary-limit window can be minutes long. Sleeping it out would
      // blow the classify job's own timeout, so clamp and let the exhausted
      // read fail the current manual invocation.
      return Math.min(error.retryAfterMs, WATCHDOG_READ_RETRY_MAX_MS);
    }
    // Full jitter: pick uniformly below the exponential ceiling so the six
    // concurrent job reads do not re-collide on one backoff boundary.
    const ceiling = Math.min(WATCHDOG_READ_RETRY_BASE_MS * (2 ** attempt), WATCHDOG_READ_RETRY_MAX_MS);
    return Math.round(this.random() * ceiling);
  }

  #retryAfterMs(headers) {
    const retryAfter = headers.get('retry-after');
    if (retryAfter !== null && retryAfter.trim() !== '') {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) return Math.max(0, at - this.now());
    }
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'));
      if (Number.isSafeInteger(reset) && reset > 0) return Math.max(0, reset * 1_000 - this.now());
    }
    return null;
  }

  async #requestOnce(method, url, body) {
    this.requestCount += 1;
    if (this.requestCount > this.maxRequests) {
      throw new GitHubWatchdogError(
        method === 'POST' ? 'GITHUB_DISPATCH_AMBIGUOUS' : 'GITHUB_READ_BUDGET_EXCEEDED',
        'GitHub watchdog request budget was exhausted',
        { ambiguous: method === 'POST' },
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('GitHub watchdog request timed out', 'TimeoutError')),
      this.requestTimeoutMs,
    );
    try {
      const response = await this.fetchImpl(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'user-agent': GITHUB_WATCHDOG_USER_AGENT,
          'x-github-api-version': GITHUB_API_VERSION,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!(response instanceof Response) || response.redirected) {
        throw new GitHubWatchdogError(
          method === 'POST' ? 'GITHUB_DISPATCH_AMBIGUOUS' : 'GITHUB_READ_FAILED',
          'GitHub returned an unsupported transport response',
          { ambiguous: method === 'POST' },
        );
      }
      if (!response.ok) {
        // A transient status keeps the durable hold on the dispatch path until
        // correlation proves whether a run exists, and earns a backoff retry
        // on the read path.
        const definitive = method === 'POST'
          && response.status >= 400 && response.status < 500
          && !isRetryableGitHubStatus(response.status);
        throw new GitHubWatchdogError(
          definitive ? 'GITHUB_DISPATCH_REJECTED' : method === 'POST' ? 'GITHUB_DISPATCH_AMBIGUOUS' : 'GITHUB_READ_FAILED',
          `GitHub returned HTTP ${response.status}`,
          {
            status: response.status,
            ambiguous: method === 'POST' && !definitive,
            retryAfterMs: this.#retryAfterMs(response.headers),
          },
        );
      }
      if (method === 'POST') {
        if (response.status === 204) return { runId: null };
        const text = await response.text();
        if (!text) {
          throw new GitHubWatchdogError('GITHUB_DISPATCH_AMBIGUOUS', 'GitHub dispatch response was empty', {
            status: response.status,
            ambiguous: true,
          });
        }
        let data;
        try {
          data = JSON.parse(text);
        } catch (cause) {
          throw new GitHubWatchdogError('GITHUB_DISPATCH_AMBIGUOUS', 'GitHub dispatch response was malformed', {
            status: response.status,
            ambiguous: true,
            cause,
          });
        }
        const runId = data?.workflow_run_id;
        if (!validGitHubId(runId)) {
          throw new GitHubWatchdogError('GITHUB_DISPATCH_AMBIGUOUS', 'GitHub dispatch response had no run id', {
            status: response.status,
            ambiguous: true,
          });
        }
        return { runId, runAttempt: 1 };
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^application\/json(?:;|$)/i.test(contentType)) {
        throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'GitHub read response was not JSON', {
          status: response.status,
        });
      }
      const text = await response.text();
      try {
        return { data: JSON.parse(text), headers: response.headers };
      } catch (cause) {
        throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'GitHub read response was malformed', {
          status: response.status,
          cause,
        });
      }
    } catch (cause) {
      if (cause instanceof GitHubWatchdogError) throw cause;
      throw new GitHubWatchdogError(
        method === 'POST'
          ? 'GITHUB_DISPATCH_AMBIGUOUS'
          : controller.signal.aborted ? 'GITHUB_READ_TIMEOUT' : 'GITHUB_READ_FAILED',
        controller.signal.aborted ? 'GitHub watchdog request timed out' : 'GitHub transport failed',
        { ambiguous: method === 'POST', cause },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async #paginate(firstPath, readItems, {
    readTotalCount = null,
    readItemId = null,
    collectionName = 'GitHub collection',
    stopWhen = null,
    requireShortFinalPage = false,
  } = {}) {
    const items = [];
    const itemIds = new Set();
    let next = firstPath;
    let pages = 0;
    let frozenTotalCount = null;
    let finalPageLength = 0;
    while (next) {
      pages += 1;
      if (pages > WATCHDOG_MAX_PAGES) {
        throw new GitHubWatchdogError(
          'GITHUB_READ_BUDGET_EXCEEDED',
          'GitHub pagination exceeded the watchdog page budget',
        );
      }
      const response = await this.request('GET', next);
      const pageItems = readItems(response.data);
      if (!Array.isArray(pageItems)) throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'GitHub page shape was invalid');
      if (readTotalCount !== null) {
        const totalCount = readTotalCount(response.data);
        if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
          throw new GitHubWatchdogError('GITHUB_READ_FAILED', `${collectionName} total_count was invalid`);
        }
        if (frozenTotalCount === null) frozenTotalCount = totalCount;
        if (totalCount !== frozenTotalCount) {
          throw new GitHubWatchdogError('GITHUB_READ_FAILED', `${collectionName} total_count changed during pagination`);
        }
        if (pageItems.length === 0 && items.length < frozenTotalCount) {
          throw new GitHubWatchdogError('GITHUB_READ_FAILED', `${collectionName} returned an empty truncated page`);
        }
        for (const item of pageItems) {
          const itemId = readItemId(item);
          if (!validGitHubId(itemId) || itemIds.has(String(itemId))) {
            throw new GitHubWatchdogError('GITHUB_READ_FAILED', `${collectionName} contained an invalid or duplicate id`);
          }
          itemIds.add(String(itemId));
        }
      }
      items.push(...pageItems);
      finalPageLength = pageItems.length;
      // A caller that only needs a prefix of a newest-first collection stops
      // here, before the link is even parsed, and pays for no page behind the
      // item it was looking for.
      if (stopWhen !== null && stopWhen(items)) return items;
      // GitHub answers every paginated read with a `next` link on the numeric
      // repository-ID path (`/repositories/<id>/statuses/<sha>`), not the
      // `/repos/<owner>/<repo>/...` path that was requested, so comparing the
      // two never matches. Following that link put every page after the first
      // outside the allowlist, so the walk aborted and the watchdog deferred
      // forever. Treat the link as nothing but a boolean "another page exists"
      // and synthesize the next request from our own path. `#authorize`
      // already rejected the rewritten path on its own, so this is a
      // correctness fix, not a routing-exposure one.
      //
      // Completeness is proven per collection, NOT uniformly: the frozen
      // total_count, duplicate-id, and truncation checks below all sit behind
      // `frozenTotalCount !== null`, so they are inert for any caller that
      // passes no readTotalCount. readNewestGate is exactly that caller — and
      // the only one that paginates in production — which is why it opts into
      // `stopWhen` and `requireShortFinalPage` instead. See the rule at the
      // end of this walk.
      //
      // Nothing validates the page cursor here because nothing can move it off
      // the arithmetic: every caller starts at a literal `page=1`, the loop is
      // the only writer, and WATCHDOG_MAX_PAGES caps the increment.
      const hasNextPage = parseNextLink(response.headers.get('link')) !== null;
      let nextPage = null;
      if (hasNextPage) {
        const synthesized = new URL(next, this.apiBase);
        synthesized.searchParams.set('page', String(Number(synthesized.searchParams.get('page')) + 1));
        nextPage = `${synthesized.pathname}${synthesized.search}`;
      }
      if (frozenTotalCount !== null) {
        if (items.length > frozenTotalCount) {
          throw new GitHubWatchdogError('GITHUB_READ_FAILED', `${collectionName} exceeded total_count`);
        }
        if (items.length < frozenTotalCount && !hasNextPage) {
          throw new GitHubWatchdogError('GITHUB_READ_FAILED', `${collectionName} pagination was truncated without next`);
        }
        if (items.length === frozenTotalCount && hasNextPage) {
          throw new GitHubWatchdogError('GITHUB_READ_FAILED', `${collectionName} exposed next after total_count`);
        }
      }
      next = nextPage;
    }
    if (frozenTotalCount !== null && items.length !== frozenTotalCount) {
      throw new GitHubWatchdogError('GITHUB_READ_FAILED', `${collectionName} did not match total_count`);
    }
    // Completeness is proven per caller. The three collections that carry
    // `total_count` use the frozen-total, duplicate-id, and truncation
    // invariants above. A collection without one cannot tell a short last page
    // apart from a silently truncated full one, so it opts into this rule: a
    // walk that drained the collection without `stopWhen` firing, yet ended on
    // a page exactly GITHUB_PAGE_SIZE long and carrying no `next`, read a
    // prefix — not the whole thing.
    if (requireShortFinalPage && finalPageLength >= GITHUB_PAGE_SIZE) {
      throw new GitHubWatchdogError(
        'GITHUB_READ_FAILED',
        `${collectionName} ended on a full page with no next link`,
      );
    }
    return items;
  }

  async readCurrentMain() {
    const { data } = await this.request('GET', `${this.repoPath}/git/ref/heads/main`);
    const sha = data?.object?.sha;
    if (!/^[0-9a-f]{40}$/i.test(sha ?? '')) throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'main ref had no exact SHA');
    return sha;
  }

  async readNewestGate(headSha) {
    // Commit statuses come back newest-first, so the first `gate` is the
    // newest one and every page behind it is dead weight. The gate currently
    // sits near the end of page one on this repository, so this both stops the
    // walk early and removes a page of I/O per snapshot.
    const statuses = await this.#paginate(
      `${this.repoPath}/commits/${headSha}/statuses?per_page=${GITHUB_PAGE_SIZE}&page=1`,
      (data) => data,
      {
        collectionName: 'commit statuses',
        stopWhen: (items) => items.some((status) => status?.context === 'gate'),
        requireShortFinalPage: true,
      },
    );
    const gate = statuses.find((status) => status?.context === 'gate');
    const state = gate?.state ?? 'missing';
    if (state !== 'missing' && !TERMINAL_GATE_STATES.includes(state)) {
      throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'newest gate state was unknown');
    }
    return { state, updatedAt: gate?.updated_at ?? null };
  }

  async readMainAndGate() {
    const sha = await this.readCurrentMain();
    return { sha, gate: await this.readNewestGate(sha) };
  }

  async #readAttemptJobs(runId, attempt) {
    return this.#paginate(
      `${this.repoPath}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${GITHUB_PAGE_SIZE}&page=1`,
      (data) => data?.jobs,
      {
        readTotalCount: (data) => data?.total_count,
        readItemId: (job) => job?.id,
        collectionName: 'workflow jobs',
      },
    );
  }

  async #readRawTargetRuns() {
    const now = this.now();
    if (!Number.isFinite(now)) throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'watchdog clock was invalid');
    const created = `>=${new Date(now - WATCHDOG_HISTORY_WINDOW_MS).toISOString()}`;
    const query = new URLSearchParams({
      created,
      filter: 'all',
      per_page: String(GITHUB_PAGE_SIZE),
      page: '1',
    });
    return this.#paginate(
      `${this.repoPath}/actions/workflows/${TARGET_WORKFLOW_FILE}/runs?${query}`,
      (data) => data?.workflow_runs,
      {
        readTotalCount: (data) => data?.total_count,
        readItemId: (run) => run?.id,
        collectionName: 'workflow runs',
      },
    );
  }

  async #readRawActiveTargetRuns() {
    const runs = [];
    for (const status of ACTIVE_RUN_STATES) {
      const query = new URLSearchParams({
        status,
        filter: 'all',
        per_page: String(GITHUB_PAGE_SIZE),
        page: '1',
      });
      runs.push(...await this.#paginate(
        `${this.repoPath}/actions/workflows/${TARGET_WORKFLOW_FILE}/runs?${query}`,
        (data) => data?.workflow_runs,
        {
          readTotalCount: (data) => data?.total_count,
          readItemId: (run) => run?.id,
          collectionName: `${status} workflow runs`,
        },
      ));
    }
    return runs;
  }

  #summarizeTargetRun(run) {
    if (!validGitHubId(run?.id)) {
      throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'workflow run id was invalid');
    }
    if (!Number.isSafeInteger(run?.run_attempt) || run.run_attempt < 1) {
      throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'workflow run attempt count was invalid');
    }
    const active = ACTIVE_RUN_STATES.includes(run?.status);
    if (!/^[0-9a-f]{40}$/i.test(run?.head_sha ?? '')
      || !(active || run?.status === 'completed')
      || (active && run?.conclusion !== null)
      || (run?.status === 'completed' && typeof run?.conclusion !== 'string')
      || !Number.isFinite(Date.parse(run?.created_at ?? ''))
      || !Number.isFinite(Date.parse(run?.updated_at ?? ''))) {
      throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'workflow run summary was invalid');
    }
    return {
      id: run.id,
      runAttempt: run.run_attempt,
      displayTitle: run.display_title ?? '',
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    };
  }

  async readTargetRunSummaries() {
    const activeBefore = (await this.#readRawActiveTargetRuns()).map((run) => this.#summarizeTargetRun(run));
    const history = (await this.#readRawTargetRuns()).map((run) => this.#summarizeTargetRun(run));
    const activeAfter = (await this.#readRawActiveTargetRuns()).map((run) => this.#summarizeTargetRun(run));
    const inventoryKey = (runs) => JSON.stringify(runs
      .map((run) => [run.id, run.runAttempt, run.headSha, run.status, run.createdAt])
      .sort(([left], [right]) => left - right));
    if (inventoryKey(activeBefore) !== inventoryKey(activeAfter)) {
      throw new GitHubWatchdogError(
        'GITHUB_READ_FAILED',
        'active workflow inventory changed during the watchdog snapshot',
      );
    }
    const byId = new Map(history.map((run) => [String(run.id), run]));
    for (const run of activeAfter) byId.set(String(run.id), run);
    return [...byId.values()];
  }

  async hydrateTargetRuns(runSummaries) {
    if (!Array.isArray(runSummaries)) {
      throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'workflow run summaries were invalid');
    }
    const attemptsByRun = runSummaries.map((run) => {
      if (!validGitHubId(run?.id) || !Number.isSafeInteger(run?.runAttempt) || run.runAttempt < 1) {
        throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'workflow run attempt count was invalid');
      }
      return new Array(run.runAttempt);
    });
    const reads = [];
    for (const [runIndex, run] of runSummaries.entries()) {
      for (let attempt = 1; attempt <= run.runAttempt; attempt += 1) {
        reads.push({ runIndex, runId: run.id, attempt });
      }
    }
    await mapWithConcurrency(reads, WATCHDOG_JOB_READ_CONCURRENCY, async ({ runIndex, runId, attempt }) => {
      attemptsByRun[runIndex][attempt - 1] = {
        attempt,
        jobs: await this.#readAttemptJobs(runId, attempt),
      };
    });
    return runSummaries.map((run, runIndex) => (
      {
        ...run,
        attempts: attemptsByRun[runIndex],
        hydrated: true,
      }
    ));
  }

  async readTargetRuns(runSummaries = null) {
    return this.hydrateTargetRuns(runSummaries ?? await this.readTargetRunSummaries());
  }

  async findRunByRecoveryAttemptId(recoveryAttemptId, runs = null) {
    if (!validIdentifier(recoveryAttemptId)) throw new TypeError('recovery attempt id is invalid');
    const history = runs ?? await this.readTargetRunSummaries();
    return history.find((run) => (
      displayTitleHasIdentifier(run.displayTitle, recoveryAttemptId)
    )) ?? null;
  }

  async readSourceRunIdentity({ sourceRunId, sourceRunAttempt, expectedSourceHeadSha = null }) {
    if (!validGitHubRunId(sourceRunId)) throw new TypeError('source workflow run id is invalid');
    if (!Number.isInteger(sourceRunAttempt) || sourceRunAttempt < 1 || sourceRunAttempt > 1_000) {
      throw new TypeError('source workflow run attempt is invalid');
    }
    if (expectedSourceHeadSha !== null && !/^[0-9a-f]{40}$/i.test(expectedSourceHeadSha ?? '')) {
      throw new TypeError('expected source workflow head is invalid');
    }
    const normalizedRunId = String(sourceRunId);
    const { data: run } = await this.request(
      'GET',
      `${this.repoPath}/actions/runs/${normalizedRunId}/attempts/${sourceRunAttempt}`,
    );
    const workflowPath = typeof run?.path === 'string' ? run.path.split('@', 1)[0] : '';
    const spec = SOURCE_WORKFLOW_SPECS.find(({ workflowFile, events }) => {
      const exactPath = `.github/workflows/${workflowFile}`;
      return (run?.path === exactPath || run?.path === `${exactPath}@refs/heads/main`)
        && events.includes(run?.event);
    });
    const active = ACTIVE_RUN_STATES.includes(run?.status);
    const terminal = run?.status === 'completed' && TERMINAL_RUN_CONCLUSIONS.includes(run?.conclusion);
    if (!spec
      || String(run?.id) !== normalizedRunId
      || run?.run_attempt !== sourceRunAttempt
      || run?.head_branch !== 'main'
      || (expectedSourceHeadSha !== null && run?.head_sha !== expectedSourceHeadSha)
      || !/^[0-9a-f]{40}$/i.test(run?.head_sha ?? '')
      || !(active || terminal)
      || (active && run?.conclusion !== null)) {
      throw new GitHubWatchdogError(
        'GITHUB_READ_FAILED',
        'source workflow run identity was not exact',
      );
    }
    return {
      sourceRunId: normalizedRunId,
      sourceRunAttempt,
      workflowPath,
      event: run.event,
      ref: 'refs/heads/main',
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      dispatchJobName: spec.dispatchJobName,
      dispatchStepName: spec.dispatchStepName,
    };
  }

  async readSourceDispatchEvidence({ sourceRunId, sourceRunAttempt, expectedSourceHeadSha }) {
    const identity = await this.readSourceRunIdentity({
      sourceRunId,
      sourceRunAttempt,
      expectedSourceHeadSha,
    });
    const jobs = await this.#readAttemptJobs(identity.sourceRunId, sourceRunAttempt);
    return {
      ...identity,
      jobs,
    };
  }

  async readDispatchedRunIdentity({ runId, runAttempt = 1, expectedHeadSha }) {
    if (!validGitHubRunId(runId)) throw new TypeError('dispatched workflow run id is invalid');
    if (runAttempt !== 1) throw new TypeError('dispatched workflow run attempt must be 1');
    if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha ?? '')) {
      throw new TypeError('expected dispatched workflow head is invalid');
    }
    const normalizedRunId = String(runId);
    const { data: run } = await this.request(
      'GET',
      `${this.repoPath}/actions/runs/${normalizedRunId}/attempts/${runAttempt}`,
    );
    const workflowPath = typeof run?.path === 'string' ? run.path.split('@', 1)[0] : '';
    if (String(run?.id) !== normalizedRunId
      || run?.run_attempt !== runAttempt
      || run?.event !== 'workflow_dispatch'
      || run?.head_branch !== 'main'
      || run?.head_sha !== expectedHeadSha
      || workflowPath !== `.github/workflows/${TARGET_WORKFLOW_FILE}`) {
      throw new GitHubWatchdogError(
        'GITHUB_READ_FAILED',
        'dispatched workflow run identity was not exact',
      );
    }
    return { id: normalizedRunId, runAttempt };
  }

  dispatchRecovery({ recoveryAttemptId, expectedHeadSha }) {
    return this.request(
      'POST',
      `${this.repoPath}/actions/workflows/${TARGET_WORKFLOW_FILE}/dispatches`,
      {
        body: {
          ref: 'main',
          return_run_details: true,
          inputs: {
            recovery_attempt_id: recoveryAttemptId,
            expected_head_sha: expectedHeadSha,
          },
        },
      },
    );
  }
}

function successfulStepLocations(run, stepName) {
  const locations = [];
  for (const attempt of run?.attempts ?? []) {
    for (const [jobIndex, job] of (attempt?.jobs ?? []).entries()) {
      for (const [stepIndex, step] of (job?.steps ?? []).entries()) {
        if (step?.name === stepName && step?.conclusion === 'success') {
          locations.push({ attempt: attempt.attempt, jobIndex, stepIndex });
        }
      }
    }
  }
  return locations;
}

function hasSuccessfulStep(run, stepName) {
  return successfulStepLocations(run, stepName).length > 0;
}

function isActiveRun(run) {
  return ACTIVE_RUN_STATES.includes(run?.status)
    && (run?.conclusion === null || run?.conclusion === undefined);
}

function runAgeMs(run, now) {
  const createdAt = Date.parse(run?.createdAt ?? '');
  return Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : null;
}

function markerWasSuperseded(run, controlState, markerStepName) {
  const markers = successfulStepLocations(run, markerStepName);
  if (markers.length === 0) return false;
  const acceptedLocations = successfulStepLocations(run, FINAL_ACCEPTANCE_STEP_NAME);
  const currentAttempt = controlState?.currentAttempt;
  const supersededRuns = [
    ...(Array.isArray(controlState?.lastAccepted?.supersededRuns)
      ? controlState.lastAccepted.supersededRuns
      : []),
    ...(['TERMINAL_ACCEPTED', 'OPERATOR_RESOLVED'].includes(currentAttempt?.state)
      && Array.isArray(currentAttempt.supersededRuns)
      ? currentAttempt.supersededRuns
      : []),
  ];

  return markers.every((marker) => (
    acceptedLocations.some((accepted) => (
      accepted.attempt > marker.attempt
      // The terminal acceptance step runs in the verifier job, after the
      // mutation job through an explicit `needs` edge. GitHub job indexes are
      // only response-array positions, not workflow order, so an exact
      // acceptance in the same run attempt retires that attempt's markers
      // regardless of which job array entry contains it.
      || accepted.attempt === marker.attempt
    ))
    || supersededRuns.some((superseded) => (
      validGitHubRunId(superseded?.runId)
      && String(superseded.runId) === String(run.id)
      && Number.isInteger(superseded.runAttempt)
      && superseded.runAttempt === marker.attempt
    ))
  ));
}

function hasCompleteRunHistory(runs) {
  if (!Array.isArray(runs)) return false;
  return runs.every((run) => (
    run
    && (typeof run.id === 'string' || Number.isSafeInteger(run.id))
    && /^[0-9a-f]{40}$/i.test(run.headSha ?? '')
    && ['queued', 'in_progress', 'waiting', 'pending', 'requested', 'completed'].includes(run.status)
    && Number.isFinite(Date.parse(run.createdAt ?? ''))
    && Array.isArray(run.attempts)
    && run.attempts.every((attempt) => (
      Number.isSafeInteger(attempt?.attempt)
      && attempt.attempt > 0
      && Array.isArray(attempt.jobs)
    ))
  ));
}

export function classifyWatchdogSnapshot({ now, main, runs, controlState }) {
  if (!Number.isFinite(now) || !/^[0-9a-f]{40}$/i.test(main?.sha ?? '')) {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: null,
      dispatchEligible: false,
      reason: 'current main could not be resolved exactly',
    };
  }
  if (!hasCompleteRunHistory(runs) || !controlState || typeof controlState !== 'object') {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: main.sha,
      dispatchEligible: false,
      reason: 'target workflow history is missing or incomplete',
    };
  }
  if (controlState?.barrier) {
    const barrierAttemptId = controlState.barrier.attemptId;
    const correlatedAttempt = controlState.currentAttempt?.attemptId === barrierAttemptId
      ? controlState.currentAttempt
      : null;
    const runId = correlatedAttempt
      ? (controlState.barrier.runId ?? correlatedAttempt.runId ?? null)
      : null;
    const activeVerifier = runId === null ? null : runs.find((run) => (
      String(run.id) === String(runId) && isActiveRun(run)
    ));
    const ageMs = activeVerifier ? runAgeMs(activeVerifier, now) : null;
    if (ageMs !== null && ageMs < POST_MUTATION_ACTIVE_MS) {
      return {
        outcome: 'WAITING_FOR_ACTIVE_RUN',
        headSha: main.sha,
        dispatchEligible: false,
        priorId: barrierAttemptId,
        runId: activeVerifier.id ?? null,
        reason: 'post-mutation verifier is still inside its active safety window',
      };
    }
    return {
      outcome: 'MANUAL_REQUIRED_AFTER_MUTATION',
      headSha: main.sha,
      dispatchEligible: false,
      priorId: barrierAttemptId,
      reason: 'a global mutation barrier has no young active verifier',
    };
  }
  if (Array.isArray(controlState?.dispatchHolds) && controlState.dispatchHolds.length > 0) {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: main.sha,
      dispatchEligible: false,
      recoveryAttemptId: controlState.dispatchHolds[0]?.recoveryAttemptId ?? null,
      priorId: controlState.dispatchHolds[0]?.recoveryAttemptId ?? null,
      reason: 'an unresolved dispatch hold requires exact correlation or operator resolution',
    };
  }
  let recoverableExpiredLease = false;
  if (controlState?.lease) {
    const expiresAt = controlState.lease.expiresAt;
    if (!Number.isFinite(expiresAt)) {
      return {
        outcome: 'DEFERRED_AMBIGUOUS',
        headSha: main.sha,
        dispatchEligible: false,
        reason: 'the active lease expiry is unreadable',
      };
    }
    if (expiresAt > now) {
      return {
        outcome: 'WAITING_FOR_ACTIVE_RUN',
        headSha: main.sha,
        dispatchEligible: false,
        priorId: controlState.currentAttempt?.attemptId ?? null,
        reason: 'a pre-mutation lease is still active',
      };
    }
    const attempt = controlState.currentAttempt;
    const attemptRunStillActive = runs.some((run) => (
      (attempt?.runId ? String(run.id) === String(attempt.runId) : run?.headSha === attempt?.headSha)
      && isActiveRun(run)
    ));
    const positivePreMutation = ['LEASED', 'PREPARED'].includes(attempt?.state)
      && !(attempt.state === 'PREPARED' && attempt.resultKind === 'NO_MUTATION');
    if (!positivePreMutation || attemptRunStillActive) {
      return {
        outcome: 'DEFERRED_AMBIGUOUS',
        headSha: main.sha,
        dispatchEligible: false,
        priorId: controlState.currentAttempt?.attemptId ?? null,
        reason: 'an expired lease lacks positive inactive pre-mutation proof',
      };
    }
    recoverableExpiredLease = true;
  }
  const manualMarkerRun = Array.isArray(runs)
    ? runs.find((run) => (
      hasSuccessfulStep(run, MANUAL_REQUIRED_STEP_NAME)
      && !markerWasSuperseded(run, controlState, MANUAL_REQUIRED_STEP_NAME)
    ))
    : null;
  const mutationMarkerRun = Array.isArray(runs)
    ? runs.find((run) => (
      hasSuccessfulStep(run, MUTATION_STARTED_STEP_NAME)
      && !markerWasSuperseded(run, controlState, MUTATION_STARTED_STEP_NAME)
    ))
    : null;
  if (manualMarkerRun) {
    return {
      outcome: 'MANUAL_REQUIRED_AFTER_MUTATION',
      headSha: main.sha,
      dispatchEligible: false,
      runId: manualMarkerRun.id ?? null,
      reason: 'GitHub history contains a manual-required marker',
    };
  }
  if (mutationMarkerRun) {
    const ageMs = runAgeMs(mutationMarkerRun, now);
    if (isActiveRun(mutationMarkerRun) && ageMs !== null && ageMs < POST_MUTATION_ACTIVE_MS) {
      return {
        outcome: 'WAITING_FOR_ACTIVE_RUN',
        headSha: main.sha,
        dispatchEligible: false,
        runId: mutationMarkerRun.id ?? null,
        reason: 'GitHub history shows a young active post-mutation verifier',
      };
    }
    return {
      outcome: 'MANUAL_REQUIRED_AFTER_MUTATION',
      headSha: main.sha,
      dispatchEligible: false,
      runId: mutationMarkerRun.id ?? null,
      reason: 'GitHub history contains an unaccepted mutation marker',
    };
  }
  if (['failure', 'error', 'pending', 'missing'].includes(main?.gate?.state)) {
    return {
      outcome: 'DEFERRED_NON_GREEN_MAIN',
      headSha: main.sha,
      dispatchEligible: false,
      reason: `newest gate is ${main.gate.state}`,
    };
  }
  if (main?.gate?.state !== 'success') {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: main.sha,
      dispatchEligible: false,
      reason: 'newest gate status is unknown',
    };
  }
  const accepted = controlState?.lastAccepted;
  const acceptedAge = Number.isFinite(accepted?.acceptedAt) ? now - accepted.acceptedAt : Infinity;
  const hasRunProof = runs.some((run) => (
    run?.headSha === main?.sha && hasSuccessfulStep(run, FINAL_ACCEPTANCE_STEP_NAME)
  ));
  if (
    main?.gate?.state === 'success'
    && accepted?.headSha === main.sha
    && acceptedAge >= 0
    && acceptedAge < ACCEPTED_FRESHNESS_MS
    && hasRunProof
  ) {
    return {
      outcome: 'HEALTHY',
      headSha: main.sha,
      dispatchEligible: false,
      reason: 'recent exact terminal acceptance',
    };
  }
  if (controlState.currentAttempt?.state === 'PREPARED'
    && controlState.currentAttempt?.resultKind === 'NO_MUTATION') {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: main.sha,
      dispatchEligible: false,
      reason: 'a bound no-mutation attempt is awaiting its strict verifier',
    };
  }
  const youngPreMutationRun = runs.find((run) => {
    if (!isActiveRun(run)) return false;
    const ageMs = runAgeMs(run, now);
    return ageMs !== null && ageMs < PRE_MUTATION_ACTIVE_MS;
  });
  if (youngPreMutationRun) {
    return {
      outcome: 'WAITING_FOR_ACTIVE_RUN',
      headSha: main.sha,
      dispatchEligible: false,
      runId: youngPreMutationRun.id,
      reason: 'a pre-mutation run is still inside its active safety window',
    };
  }
  if (
    main?.gate?.state === 'success'
    && controlState?.barrier === null
    && (controlState?.lease === null || recoverableExpiredLease)
    && Array.isArray(controlState?.dispatchHolds)
    && controlState.dispatchHolds.length === 0
    && Array.isArray(runs)
  ) {
    return {
      outcome: 'RECOVERY_ELIGIBLE_OBSERVE_ONLY',
      headSha: main.sha,
      dispatchEligible: true,
      reason: 'terminal acceptance is stale and no recovery fence is active',
    };
  }
  return {
    outcome: 'DEFERRED_AMBIGUOUS',
    headSha: main?.sha ?? null,
    dispatchEligible: false,
    reason: 'watchdog evidence is incomplete',
  };
}

function unwrapControl(result) {
  const data = result?.data ?? result;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('control state response was invalid');
  }
  return data;
}

function deferredMain(main, expectedHeadSha) {
  const moved = main?.sha !== expectedHeadSha;
  return {
    outcome: moved || main?.gate?.state !== 'success'
      ? 'DEFERRED_NON_GREEN_MAIN'
      : 'DEFERRED_AMBIGUOUS',
    headSha: main?.sha ?? null,
    dispatchEligible: false,
    reason: moved ? 'main moved before recovery authorization' : `newest gate is ${main?.gate?.state ?? 'unknown'}`,
  };
}

function evidenceDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sourceDispatchRejectionEvidence(hold, evidence) {
  if (!validGitHubRunId(hold?.sourceRunId)
    || !Number.isInteger(hold?.sourceRunAttempt)
    || hold.sourceRunAttempt < 1
    || !/^[0-9a-f]{40}$/i.test(hold?.sourceHeadSha ?? '')
    || String(evidence?.sourceRunId) !== String(hold.sourceRunId)
    || evidence?.sourceRunAttempt !== hold.sourceRunAttempt
    || evidence?.headSha !== hold.sourceHeadSha
    || evidence?.ref !== 'refs/heads/main'
    || evidence?.status !== 'completed'
    || !TERMINAL_RUN_CONCLUSIONS.includes(evidence?.conclusion)
    || !Array.isArray(evidence?.jobs)) {
    return null;
  }
  const spec = SOURCE_WORKFLOW_SPECS.find(({ workflowFile, events, dispatchJobName, dispatchStepName }) => (
    evidence.workflowPath === `.github/workflows/${workflowFile}`
    && events.includes(evidence.event)
    && evidence.dispatchJobName === dispatchJobName
    && evidence.dispatchStepName === dispatchStepName
  ));
  if (!spec) return null;

  const dispatchJobs = evidence.jobs.filter((job) => job?.name === spec.dispatchJobName);
  if (dispatchJobs.length === 0) {
    return {
      reason: 'PRE_DISPATCH_NOT_STARTED',
      evidence: {
        kind: 'DISPATCH_JOB_NOT_CREATED',
        sourceRunId: String(hold.sourceRunId),
        sourceRunAttempt: hold.sourceRunAttempt,
        workflowPath: evidence.workflowPath,
        event: evidence.event,
        ref: evidence.ref,
        headSha: evidence.headSha,
        runStatus: evidence.status,
        runConclusion: evidence.conclusion,
        dispatchJobName: spec.dispatchJobName,
        dispatchStepName: spec.dispatchStepName,
      },
    };
  }
  if (dispatchJobs.length !== 1) return null;
  const [job] = dispatchJobs;
  if (!Array.isArray(job.steps)) return null;
  const dispatchSteps = job.steps.filter((step) => step?.name === spec.dispatchStepName);
  const rejectionMarkers = [
    [PRE_DISPATCH_REJECTION_STEP_NAME, 'PRE_DISPATCH_NOT_STARTED'],
    [GITHUB_DISPATCH_REJECTION_STEP_NAME, 'DISPATCH_CONFIRMED_REJECTED'],
  ].flatMap(([stepName, reason]) => job.steps
    .filter((step) => step?.name === stepName
      && step?.status === 'completed'
      && step?.conclusion === 'success')
    .map((step) => ({ step, stepName, reason })));
  if (dispatchSteps.length === 1 && rejectionMarkers.length === 1) {
    const [{ stepName, reason }] = rejectionMarkers;
    return {
      reason,
      evidence: {
        kind: reason === 'PRE_DISPATCH_NOT_STARTED'
          ? 'WORKFLOW_PRE_DISPATCH_REJECTION_RECORDED'
          : 'WORKFLOW_GITHUB_DISPATCH_REJECTION_RECORDED',
        sourceRunId: String(hold.sourceRunId),
        sourceRunAttempt: hold.sourceRunAttempt,
        workflowPath: evidence.workflowPath,
        event: evidence.event,
        ref: evidence.ref,
        headSha: evidence.headSha,
        runStatus: evidence.status,
        runConclusion: evidence.conclusion,
        dispatchJobId: String(job.id),
        dispatchJobName: spec.dispatchJobName,
        dispatchStepName: spec.dispatchStepName,
        rejectionStepName: stepName,
      },
    };
  }
  if (dispatchSteps.length === 1
    && dispatchSteps[0]?.status === 'completed'
    && dispatchSteps[0]?.conclusion === 'skipped') {
    return {
      reason: 'PRE_DISPATCH_NOT_STARTED',
      evidence: {
        kind: 'DISPATCH_POST_STEP_SKIPPED',
        sourceRunId: String(hold.sourceRunId),
        sourceRunAttempt: hold.sourceRunAttempt,
        workflowPath: evidence.workflowPath,
        event: evidence.event,
        ref: evidence.ref,
        headSha: evidence.headSha,
        runStatus: evidence.status,
        runConclusion: evidence.conclusion,
        dispatchJobId: String(job.id),
        dispatchJobName: spec.dispatchJobName,
        dispatchJobConclusion: job.conclusion,
        dispatchStepName: spec.dispatchStepName,
        dispatchStepConclusion: 'skipped',
      },
    };
  }
  if (dispatchSteps.length !== 0) return null;
  const jobWasNeverStarted = job?.status === 'completed'
    && (
      job?.conclusion === 'skipped'
      || (job?.conclusion === 'cancelled' && (job?.started_at === null || job?.started_at === undefined))
    );
  if (!jobWasNeverStarted) return null;
  return {
    reason: 'PRE_DISPATCH_NOT_STARTED',
    evidence: {
      kind: 'DISPATCH_JOB_NOT_STARTED',
      sourceRunId: String(hold.sourceRunId),
      sourceRunAttempt: hold.sourceRunAttempt,
      workflowPath: evidence.workflowPath,
      event: evidence.event,
      ref: evidence.ref,
      headSha: evidence.headSha,
      runStatus: evidence.status,
      runConclusion: evidence.conclusion,
      dispatchJobId: String(job.id),
      dispatchJobName: spec.dispatchJobName,
      dispatchJobConclusion: job.conclusion,
      dispatchStepName: spec.dispatchStepName,
    },
  };
}

async function recoverNeverStartedDispatchHold({ github, control, hold }) {
  if (!validIdentifier(hold?.recoveryAttemptId)
    || !/^[0-9a-f]{40}$/i.test(hold?.headSha ?? '')
    || !validGitHubRunId(hold?.sourceRunId)
    || !Number.isInteger(hold?.sourceRunAttempt)
    || hold.sourceRunAttempt < 1) {
    return false;
  }
  let evidence;
  try {
    evidence = await github.readSourceDispatchEvidence({
      sourceRunId: hold.sourceRunId,
      sourceRunAttempt: hold.sourceRunAttempt,
      expectedSourceHeadSha: hold.sourceHeadSha,
    });
  } catch {
    return false;
  }
  const rejection = sourceDispatchRejectionEvidence(hold, evidence);
  if (!rejection) return false;
  try {
    await rejectHeldDispatch(control, {
      recoveryAttemptId: hold.recoveryAttemptId,
      headSha: hold.headSha,
      sourceRunId: String(hold.sourceRunId),
      sourceRunAttempt: hold.sourceRunAttempt,
      reason: rejection.reason,
      evidence: rejection.evidence,
    });
    return true;
  } catch {
    return false;
  }
}

function durableRunReferences(controlState) {
  const runIds = new Set();
  const identifiers = new Set();
  const records = [
    controlState?.currentAttempt,
    controlState?.barrier,
    controlState?.lastAccepted,
    ...(controlState?.dispatchHolds ?? []),
  ].filter((record) => record && typeof record === 'object' && !Array.isArray(record));
  const identifierKeys = new Set([
    'attemptId',
    'recoveryAttemptId',
    'linkedAttemptId',
    'supersedesAttemptId',
    'supersedesDispatchHoldId',
    'operatorResolutionId',
  ]);

  for (const record of records) {
    if (record.runId !== null && record.runId !== undefined) runIds.add(String(record.runId));
    for (const key of identifierKeys) {
      if (validIdentifier(record[key])) identifiers.add(record[key]);
    }
  }
  return { runIds, identifiers };
}

function acceptedHistoryWatermark(controlState, now) {
  const accepted = controlState?.lastAccepted;
  if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) return null;
  if (!validIdentifier(accepted.attemptId)
    || !validGitHubRunId(accepted.runId)
    || !/^[0-9a-f]{40}$/i.test(accepted.headSha ?? '')
    || !Number.isFinite(accepted.acceptedAt)
    || accepted.acceptedAt < 0
    || accepted.acceptedAt > now) {
    return null;
  }
  return accepted.acceptedAt;
}

function selectRunSummariesForHydration({ now, runSummaries, controlState }) {
  if (!Number.isFinite(now) || !Array.isArray(runSummaries)) {
    throw new GitHubWatchdogError('GITHUB_READ_FAILED', 'workflow run hydration inputs were invalid');
  }
  const { runIds, identifiers } = durableRunReferences(controlState);
  const recentCutoff = now - Math.max(
    ACCEPTED_FRESHNESS_MS,
    PRE_MUTATION_ACTIVE_MS,
    POST_MUTATION_ACTIVE_MS,
  );
  const identifierList = [...identifiers];
  const acceptedAt = acceptedHistoryWatermark(controlState, now);
  const barrierActive = controlState?.barrier !== null
    && controlState?.barrier !== undefined;
  return runSummaries.filter((run) => {
    const durableReference = runIds.has(String(run.id))
      || identifierList.some((identifier) => displayTitleHasIdentifier(run.displayTitle, identifier));
    if (isActiveRun(run) || durableReference) return true;

    // A durable mutation barrier is already stronger than any GitHub marker:
    // classification cannot authorize a retry until protected operator
    // resolution clears it. Reading every older failed job adds no safety and
    // can make the observer blind before it reports the barrier itself.
    if (barrierActive) return false;

    const createdAt = Date.parse(run.createdAt);
    const updatedAt = Date.parse(run.updatedAt);
    const terminalNonSuccess = run.status === 'completed'
      && !['success', 'skipped'].includes(run.conclusion);
    if (acceptedAt !== null) {
      // Strict terminal acceptance is a durable evidence watermark. Earlier
      // failures are retired by that exact acceptance; a run created earlier
      // but completed later is still hydrated through updatedAt.
      return terminalNonSuccess && (createdAt >= acceptedAt || updatedAt >= acceptedAt);
    }

    // Before the first strict acceptance there is no safe watermark. Preserve
    // the full fail-closed scan and its recent-success proof surface.
    return terminalNonSuccess || createdAt >= recentCutoff || updatedAt >= recentCutoff;
  });
}

function mergeRunInventory(runSummaries, hydratedRuns) {
  const hydratedById = new Map(hydratedRuns.map((run) => [String(run.id), run]));
  return runSummaries.map((summary) => hydratedById.get(String(summary.id)) ?? {
    ...summary,
    attempts: [],
    hydrated: false,
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readWatchdogSnapshot({ github, control, clock = Date.now }) {
  const now = clock();
  const [mainRead, runSummariesRead, controlRead] = await Promise.allSettled([
    github.readMainAndGate(),
    github.readTargetRunSummaries(),
    control.status(),
  ]);
  // A control-plane rejection can settle before a concurrent GitHub read
  // rejection. Preserve GitHub blindness as the primary failure so the named
  // workflow marker and sustained-failure escalation cannot stay green.
  const githubReadFailure = [mainRead, runSummariesRead].find(
    (read) => read.status === 'rejected' && readFailureCodeOf(read.reason),
  );
  if (githubReadFailure) throw githubReadFailure.reason;
  for (const read of [controlRead, mainRead, runSummariesRead]) {
    if (read.status === 'rejected') throw read.reason;
  }
  const main = mainRead.value;
  const runSummaries = runSummariesRead.value;
  const status = controlRead.value;
  let controlState = unwrapControl(status);
  const relevantSummaries = selectRunSummariesForHydration({ now, runSummaries, controlState });
  const hydratedRuns = await github.hydrateTargetRuns(relevantSummaries);
  const runInventory = mergeRunInventory(runSummaries, hydratedRuns);

  // This loop repairs only an authorization that already exists. It never
  // creates a hold or dispatches a run, so it stays active even when automatic
  // recovery is disabled. Otherwise a successful GitHub dispatch followed by
  // a failed bind step could leave the durable hold ambiguous forever.
  for (const hold of controlState.dispatchHolds ?? []) {
    if (hold?.state !== 'DISPATCH_HELD' || !hold.recoveryAttemptId) continue;
    const correlated = await github.findRunByRecoveryAttemptId(hold.recoveryAttemptId, runInventory);
    if (correlated) {
      await control.bindRun({
        recoveryAttemptId: hold.recoveryAttemptId,
        headSha: hold.headSha,
        runId: String(correlated.id),
        runAttempt: correlated.runAttempt,
      });
      controlState = unwrapControl(await control.status());
      continue;
    }
    if (await recoverNeverStartedDispatchHold({ github, control, hold })) {
      controlState = unwrapControl(await control.status());
    }
  }
  // Classification receives only histories whose jobs were positively read.
  // Old terminal-success summaries remain in runInventory for correlation,
  // but an empty synthetic attempts array must never prove marker absence.
  return { now, main, runs: hydratedRuns, controlState };
}

export async function prepareRecoveryDispatch({
  github,
  control,
  clock = Date.now,
  autoRecoveryEnabled = false,
  recoveryId = randomUUID,
  sourceRunId = process.env.GITHUB_RUN_ID,
  sourceRunAttempt = Number(process.env.GITHUB_RUN_ATTEMPT),
}) {
  let snapshot;
  try {
    snapshot = await readWatchdogSnapshot({ github, control, clock });
  } catch (error) {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: null,
      dispatchEligible: false,
      dispatchAuthorized: false,
      reason: error instanceof Error ? error.message : String(error),
      readFailureCode: readFailureCodeOf(error),
    };
  }
  const classified = classifyWatchdogSnapshot(snapshot);
  if (!classified.dispatchEligible || autoRecoveryEnabled !== true) {
    return { ...classified, dispatchAuthorized: false };
  }

  let exact;
  try {
    exact = await github.readMainAndGate();
  } catch (error) {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: snapshot.main.sha,
      dispatchEligible: false,
      dispatchAuthorized: false,
      reason: error instanceof Error ? error.message : String(error),
      readFailureCode: readFailureCodeOf(error),
    };
  }
  if (exact.sha !== snapshot.main.sha || exact.gate?.state !== 'success') {
    return { ...deferredMain(exact, snapshot.main.sha), dispatchAuthorized: false };
  }

  const recoveryAttemptId = recoveryId();
  if (!validGitHubRunId(sourceRunId)
    || !Number.isInteger(sourceRunAttempt)
    || sourceRunAttempt < 1
    || sourceRunAttempt > 1_000) {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: exact.sha,
      dispatchEligible: false,
      dispatchAuthorized: false,
      reason: 'current watchdog source run identity was invalid',
    };
  }
  let sourceIdentity;
  try {
    sourceIdentity = await github.readSourceRunIdentity({
      sourceRunId,
      sourceRunAttempt,
    });
  } catch (error) {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: exact.sha,
      dispatchEligible: false,
      dispatchAuthorized: false,
      reason: error instanceof Error ? error.message : String(error),
      readFailureCode: readFailureCodeOf(error),
    };
  }
  try {
    await control.createDispatchHold({
      recoveryAttemptId,
      headSha: exact.sha,
      sourceHeadSha: sourceIdentity.headSha,
      sourceRunId: String(sourceRunId),
      sourceRunAttempt,
    });
  } catch (error) {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: exact.sha,
      dispatchEligible: false,
      dispatchAuthorized: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ...classified,
    outcome: 'RECOVERY_AUTHORIZED',
    headSha: exact.sha,
    dispatchAuthorized: true,
    recoveryAttemptId,
    reason: 'recovery predicates passed and a durable dispatch hold was created',
  };
}

async function rejectHeldDispatch(control, {
  recoveryAttemptId,
  headSha,
  sourceRunId,
  sourceRunAttempt,
  reason,
  evidence,
}) {
  await control.rejectDispatch({
    recoveryAttemptId,
    headSha,
    reason,
    evidenceDigest: evidenceDigest(evidence),
    ...(reason === 'PRE_DISPATCH_NOT_STARTED' ? { sourceRunId, sourceRunAttempt } : {}),
  });
}

export async function dispatchGitHubRecovery({
  github,
  expectedHeadSha,
  recoveryAttemptId,
  sourceRunId = process.env.GITHUB_RUN_ID,
  sourceRunAttempt = Number(process.env.GITHUB_RUN_ATTEMPT),
  sleep = defaultSleep,
  correlationAttempts = DISPATCH_CORRELATION_ATTEMPTS,
  correlationPollMs = DISPATCH_CORRELATION_POLL_MS,
}) {
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  if (!Number.isInteger(correlationAttempts) || correlationAttempts < 1 || correlationAttempts > 10) {
    throw new TypeError('correlation attempts must be an integer from 1 to 10');
  }
  if (!Number.isInteger(correlationPollMs) || correlationPollMs < 0 || correlationPollMs > 10_000) {
    throw new TypeError('correlation poll delay must be an integer from 0 to 10000ms');
  }
  let exact;
  try {
    exact = await github.readMainAndGate();
  } catch (error) {
    const evidence = {
      kind: 'IN_PROCESS_PRE_DISPATCH_READ_EXIT',
      recoveryAttemptId,
      expectedHeadSha,
      sourceRunId: String(sourceRunId),
      sourceRunAttempt,
    };
    return {
      outcome: 'PRE_DISPATCH_NOT_STARTED',
      headSha: expectedHeadSha,
      dispatchEligible: false,
      recoveryAttemptId,
      rejection: { reason: 'PRE_DISPATCH_NOT_STARTED', evidence },
      reason: `pre-dispatch main read exited before POST: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (exact.sha !== expectedHeadSha || exact.gate?.state !== 'success') {
    const evidence = {
      kind: 'IN_PROCESS_PRE_DISPATCH_MAIN_MOVED',
      recoveryAttemptId,
      expectedHeadSha,
      observedHeadSha: exact.sha ?? null,
      observedGateState: exact.gate?.state ?? null,
      sourceRunId: String(sourceRunId),
      sourceRunAttempt,
    };
    return {
      ...deferredMain(exact, expectedHeadSha),
      outcome: 'PRE_DISPATCH_NOT_STARTED',
      recoveryAttemptId,
      rejection: { reason: 'PRE_DISPATCH_NOT_STARTED', evidence },
      reason: 'main moved or became non-green before POST',
    };
  }

  let dispatched;
  try {
    dispatched = await github.dispatchRecovery({ recoveryAttemptId, expectedHeadSha });
  } catch (error) {
    if (error instanceof GitHubWatchdogError && error.code === 'GITHUB_DISPATCH_REJECTED') {
      const evidence = {
        kind: 'GITHUB_DISPATCH_DEFINITIVE_REJECTION',
        status: error.status,
        recoveryAttemptId,
        expectedHeadSha,
        sourceRunId: String(sourceRunId),
        sourceRunAttempt,
      };
      return {
        outcome: 'DISPATCH_CONFIRMED_REJECTED',
        headSha: expectedHeadSha,
        dispatchEligible: false,
        recoveryAttemptId,
        rejection: { reason: 'DISPATCH_CONFIRMED_REJECTED', evidence },
        reason: `GitHub definitively rejected dispatch with HTTP ${error.status}`,
      };
    }
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: expectedHeadSha,
      dispatchEligible: false,
      recoveryAttemptId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let correlatedRun = dispatched.runId === null
    ? null
    : { id: dispatched.runId, runAttempt: dispatched.runAttempt };
  if (correlatedRun === null) {
    for (let attempt = 1; attempt <= correlationAttempts; attempt += 1) {
      try {
        correlatedRun = await github.findRunByRecoveryAttemptId(recoveryAttemptId);
      } catch {
        correlatedRun = null;
      }
      if (correlatedRun !== null) break;
      if (attempt < correlationAttempts) {
        try {
          await sleep(correlationPollMs);
        } catch {
          return {
            outcome: 'DEFERRED_AMBIGUOUS',
            headSha: expectedHeadSha,
            dispatchEligible: false,
            recoveryAttemptId,
            reason: 'GitHub accepted dispatch but correlation polling was interrupted; durable hold was preserved',
          };
        }
      }
    }
  }
  if (correlatedRun === null) {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: expectedHeadSha,
      dispatchEligible: false,
      recoveryAttemptId,
      runId: null,
      runAttempt: null,
      reason: 'GitHub accepted dispatch but exact run correlation remained unresolved; durable hold was preserved',
    };
  }
  try {
    correlatedRun = await github.readDispatchedRunIdentity({
      runId: correlatedRun.id,
      runAttempt: correlatedRun.runAttempt,
      expectedHeadSha,
    });
  } catch (error) {
    return {
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: expectedHeadSha,
      dispatchEligible: false,
      recoveryAttemptId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    outcome: 'RECOVERY_DISPATCH_ACCEPTED',
    headSha: expectedHeadSha,
    dispatchEligible: false,
    recoveryAttemptId,
    runId: correlatedRun.id,
    runAttempt: correlatedRun.runAttempt,
    reason: 'GitHub accepted and verified the exact recovery run; durable binding remains separate',
  };
}

export async function rejectAuthorizedRecovery({
  control,
  expectedHeadSha,
  recoveryAttemptId,
  sourceRunId = process.env.GITHUB_RUN_ID,
  sourceRunAttempt = Number(process.env.GITHUB_RUN_ATTEMPT),
  rejection,
}) {
  if (!rejection || !['PRE_DISPATCH_NOT_STARTED', 'DISPATCH_CONFIRMED_REJECTED'].includes(rejection.reason)
    || !rejection.evidence || typeof rejection.evidence !== 'object' || Array.isArray(rejection.evidence)) {
    throw new TypeError('definitive dispatch rejection evidence is invalid');
  }
  await rejectHeldDispatch(control, {
    recoveryAttemptId,
    headSha: expectedHeadSha,
    sourceRunId: String(sourceRunId),
    sourceRunAttempt,
    reason: rejection.reason,
    evidence: rejection.evidence,
  });
  return {
    outcome: 'RECOVERY_DISPATCH_REJECTED',
    headSha: expectedHeadSha,
    dispatchEligible: false,
    recoveryAttemptId,
    reason: 'the definitive GitHub dispatch outcome closed the durable recovery hold',
  };
}

export async function bindAuthorizedRecovery({
  control,
  expectedHeadSha,
  recoveryAttemptId,
  workflowRunId,
  runAttempt,
}) {
  if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha ?? '')) {
    throw new TypeError('expected head must be an exact commit SHA');
  }
  if (!validIdentifier(recoveryAttemptId)) throw new TypeError('recovery attempt id is invalid');
  if (!validGitHubRunId(workflowRunId)) throw new TypeError('workflow run id is invalid');
  if (!Number.isInteger(runAttempt) || runAttempt !== 1) {
    throw new TypeError('watchdog dispatch must bind run attempt 1');
  }
  await control.bindRun({
    recoveryAttemptId,
    headSha: expectedHeadSha,
    runId: String(workflowRunId),
    runAttempt,
  });
  return {
    outcome: 'RECOVERY_DISPATCHED',
    headSha: expectedHeadSha,
    dispatchEligible: false,
    recoveryAttemptId,
    runId: String(workflowRunId),
    runAttempt,
    reason: 'the exact dispatched run was bound to the durable recovery hold',
  };
}

// The watchdog is manual rollback only. There is no later scheduled run that
// can accumulate a failure streak, so any unreadable GitHub state must make the
// current invocation red immediately.
export async function resolveReadFailureExit({ result }) {
  if (!result?.readFailureCode) return { failJob: false, reason: null };
  return {
    failJob: true,
    reason: `the manual watchdog could not read GitHub (${result.readFailureCode})`,
  };
}

function readArgument(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function writeWorkflowResult(result) {
  const lines = [
    `outcome=${result.outcome}`,
    `dispatch_authorized=${result.dispatchAuthorized === true}`,
    `expected_head_sha=${result.headSha ?? ''}`,
    `recovery_attempt_id=${result.recoveryAttemptId ?? ''}`,
    `prior_id=${result.priorId ?? result.recoveryAttemptId ?? ''}`,
    `workflow_run_id=${result.runId ?? ''}`,
    `run_attempt=${result.runAttempt ?? ''}`,
    // Gates the classify job's read-failure marker step, which records why the
    // current manual invocation failed.
    `read_failure=${typeof result.readFailureCode === 'string' && result.readFailureCode !== ''}`,
    `read_failure_code=${result.readFailureCode ?? ''}`,
    `rejection=${result.rejection ? Buffer.from(JSON.stringify(result.rejection)).toString('base64url') : ''}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Railway deploy trigger watchdog\n\n- Outcome: \`${result.outcome}\`\n- Prior ID: \`${result.priorId ?? result.recoveryAttemptId ?? 'none'}\`\n- Detail: ${result.reason}\n`,
    );
  }
  const warning = ['DEFERRED_AMBIGUOUS', 'DEFERRED_NON_GREEN_MAIN', 'MANUAL_REQUIRED_AFTER_MUTATION']
    .includes(result.outcome);
  console.log(`::${warning ? 'warning' : 'notice'}::${result.outcome}: ${result.reason}`);
  console.log(JSON.stringify(result));
}

async function main() {
  const phase = readArgument(process.argv, '--phase', 'classify');
  const createControl = () => new RailwayReconcileControlClient({
    baseUrl: process.env.RAILWAY_RECONCILE_CONTROL_URL,
    role: 'watchdog',
    secret: process.env.RAILWAY_RECONCILE_WATCHDOG_HMAC,
  });
  if (phase === 'classify') {
    const control = createControl();
    const github = new GitHubWatchdogClient({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
    });
    const result = await prepareRecoveryDispatch({
      github,
      control,
      autoRecoveryEnabled: readArgument(process.argv, '--auto-recovery-enabled', 'false') === 'true',
    });
    const escalation = await resolveReadFailureExit({ result });
    // The annotation goes out before the result so the machine-readable JSON
    // blob stays the last line of stdout.
    if (escalation.failJob) console.log(`::error::WATCHDOG_READ_PATH_BLIND: ${escalation.reason}`);
    writeWorkflowResult(result);
    if (escalation.failJob) process.exitCode = 1;
    return;
  }
  if (phase === 'dispatch') {
    const github = new GitHubWatchdogClient({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
    });
    const result = await dispatchGitHubRecovery({
      github,
      expectedHeadSha: readArgument(process.argv, '--expected-head-sha'),
      recoveryAttemptId: readArgument(process.argv, '--recovery-attempt-id'),
    });
    writeWorkflowResult(result);
    if (!['RECOVERY_DISPATCH_ACCEPTED', 'PRE_DISPATCH_NOT_STARTED', 'DISPATCH_CONFIRMED_REJECTED']
      .includes(result.outcome)) process.exitCode = 1;
    return;
  }
  const control = createControl();
  if (phase === 'status') {
    const response = await control.status();
    writeWorkflowResult({
      outcome: response.outcome,
      headSha: response.data?.currentAttempt?.headSha ?? null,
      priorId: response.data?.barrier?.attemptId
        ?? response.data?.dispatchHolds?.[0]?.recoveryAttemptId
        ?? response.data?.currentAttempt?.attemptId
        ?? null,
      reason: 'authenticated raw reconciliation control state follows',
      status: response.data,
    });
    return;
  }
  if (phase === 'reject') {
    let rejection;
    try {
      rejection = JSON.parse(Buffer.from(
        readArgument(process.argv, '--rejection'),
        'base64url',
      ).toString('utf8'));
    } catch (cause) {
      throw new TypeError('dispatch rejection evidence is malformed', { cause });
    }
    const result = await rejectAuthorizedRecovery({
      control,
      expectedHeadSha: readArgument(process.argv, '--expected-head-sha'),
      recoveryAttemptId: readArgument(process.argv, '--recovery-attempt-id'),
      rejection,
    });
    writeWorkflowResult(result);
    return;
  }
  if (phase === 'bind') {
    const result = await bindAuthorizedRecovery({
      control,
      expectedHeadSha: readArgument(process.argv, '--expected-head-sha'),
      recoveryAttemptId: readArgument(process.argv, '--recovery-attempt-id'),
      workflowRunId: readArgument(process.argv, '--workflow-run-id'),
      runAttempt: Number(readArgument(process.argv, '--run-attempt')),
    });
    writeWorkflowResult(result);
    return;
  }
  throw new TypeError('--phase must be classify, status, dispatch, reject, or bind');
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    // Every phase fails here, classify included. Reaching this handler means a
    // credential, a variable, or the controller itself is broken — an
    // unambiguous hard failure. Classify used to be excluded, which is what
    // made the job structurally unable to go red.
    console.log(`::error::WATCHDOG_PHASE_FAILED: ${reason}`);
    writeWorkflowResult({
      outcome: 'DEFERRED_AMBIGUOUS',
      headSha: null,
      dispatchAuthorized: false,
      reason,
    });
    process.exitCode = 1;
  });
}
