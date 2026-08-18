#!/usr/bin/env node

// Durable GitHub commit-status transitions for scheduled operational checks.
//
// A scheduled workflow run is an observation, not the incident itself. If the
// same incident is still present, the per-source status must remain non-green
// on the commit but
// the next scheduled run must not pretend that a second incident occurred.
// These helpers keep those two concerns separate:
//
//   - `updates` is the complete durable status projection for this observation;
//   - `alerting` contains only new or materially changed failures.

import { spawnSync } from 'node:child_process';

const VALID_STATES = new Set(['error', 'failure', 'pending', 'success']);
const MAX_CONTEXT_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 140;

function normalizeStatus(status) {
  if (!status || typeof status !== 'object') throw new TypeError('GitHub status must be an object');
  const context = String(status.context ?? '').trim();
  const state = String(status.state ?? '').trim();
  const description = String(status.description ?? '').trim();
  if (!context || context.length > MAX_CONTEXT_LENGTH) {
    throw new Error(`GitHub status context must contain 1-${MAX_CONTEXT_LENGTH} characters`);
  }
  if (!VALID_STATES.has(state)) throw new Error(`unsupported GitHub status state: ${state || '(empty)'}`);
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`GitHub status description must contain 1-${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return { context, state, description };
}

function statusCreatorLogin(status) {
  const login = status?.creator?.login;
  if (typeof login !== 'string' || login.length === 0) {
    throw new Error('GitHub status creator login is required to trust status history');
  }
  return login;
}

function uniqueByContext(statuses, label) {
  const byContext = new Map();
  for (const raw of statuses ?? []) {
    const status = normalizeStatus(raw);
    const existing = byContext.get(status.context);
    if (existing && (existing.state !== status.state || existing.description !== status.description)) {
      throw new Error(`${label} contains conflicting statuses for ${status.context}`);
    }
    if (!existing) byContext.set(status.context, status);
  }
  return byContext;
}

/**
 * Return the newest status for each matching context.
 *
 * `statusPages` must be newest commit first. Each commit's GitHub status array
 * must also be newest first, which is the order GitHub documents and returns.
 */
export function latestStatusesByContext(statusPages, prefix = '', { creatorLogin } = {}) {
  const latest = new Map();
  for (const statuses of statusPages ?? []) {
    if (!Array.isArray(statuses)) throw new TypeError('GitHub status page must be an array');
    for (const raw of statuses) {
      const context = typeof raw?.context === 'string' ? raw.context : '';
      if (!context.startsWith(prefix)) continue;
      // Statuses are newest first. Only the status that controls this context
      // can influence the projection; an older writer must not poison a newer,
      // trusted replacement forever.
      if (latest.has(context)) continue;
      if (creatorLogin && statusCreatorLogin(raw) !== creatorLogin) {
        throw new Error(`GitHub status ${context} was not created by trusted writer ${creatorLogin}`);
      }
      latest.set(context, normalizeStatus(raw));
    }
  }
  return latest;
}

/** Plan durable updates and new failure transitions without doing I/O. */
export function planStatusLifecycle({ current = [], previous = [] } = {}) {
  const currentByContext = uniqueByContext(current, 'current observation');
  const previousByContext = previous instanceof Map
    ? uniqueByContext([...previous.values()], 'previous observation')
    : uniqueByContext(previous, 'previous observation');
  const updates = [...currentByContext.values()];
  const alerting = [];

  for (const status of currentByContext.values()) {
    if (status.state !== 'failure' && status.state !== 'error') continue;
    const prior = previousByContext.get(status.context);
    if (!prior || prior.state !== status.state || prior.description !== status.description) {
      alerting.push(status);
    }
  }

  for (const prior of previousByContext.values()) {
    if (currentByContext.has(prior.context) || prior.state === 'success') continue;
    updates.push({
      context: prior.context,
      state: 'success',
      description: 'recovered; no longer reported',
    });
  }

  return { updates, alerting };
}

function runGh(args, { env = process.env } = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    env,
  });
  if (result.signal) throw new Error(`gh ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Read newest-first statuses for one commit. */
export function readCommitStatuses({ repository, sha, env = process.env, gh = runGh }) {
  if (!repository || !sha) throw new Error('repository and sha are required to read commit statuses');
  const output = gh([
    'api', '--paginate', '--slurp',
    `repos/${repository}/commits/${sha}/statuses?per_page=100`,
  ], { env });
  const pages = JSON.parse(output);
  if (!Array.isArray(pages)) throw new Error(`GitHub statuses for ${sha} were not an array`);
  return pages.flat();
}

/** Read the explicit status-writer trust anchor configured for the workflow. */
export function requireStatusWriterLogin({
  env = process.env,
} = {}) {
  const login = env.SEED_STATUS_WRITER_LOGIN;
  if (typeof login !== 'string' || login.length === 0) {
    throw new Error('SEED_STATUS_WRITER_LOGIN is required to trust status history');
  }
  return login;
}

/** Post one planned status projection to one exact commit. */
export function postCommitStatuses({
  repository,
  sha,
  statuses,
  targetUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined,
  env = process.env,
  gh = runGh,
}) {
  if (!repository || !sha) throw new Error('repository and sha are required to post commit statuses');
  for (const raw of statuses ?? []) {
    const status = normalizeStatus(raw);
    const args = [
      'api', '--method', 'POST',
      `repos/${repository}/statuses/${sha}`,
      '-f', `state=${status.state}`,
      '-f', `context=${status.context}`,
      '-f', `description=${status.description}`,
    ];
    if (targetUrl) args.push('-f', `target_url=${targetUrl}`);
    gh(args, { env });
  }
}
