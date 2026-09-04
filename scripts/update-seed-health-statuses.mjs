#!/usr/bin/env node

// Publish Seed Freshness as durable, per-source operational statuses.
//
// The health probe remains strict. A new or changed source incident fails this
// workflow once. Statuses live on one historical anchor commit so operational
// incidents cannot poison the check suite of an unrelated deployable revision.
// Unchanged observations append nothing. Recovery is posted only after the live
// health payload stops reporting the source.

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  latestStatusesByContext,
  planStatusLifecycle,
  postCommitStatuses,
  requireStatusWriterLogin,
  readCommitStatuses,
} from './_github-status-lifecycle.mjs';

const STATUS_PREFIX = 'ingestion/seed/';
const ACCEPTANCE_CONTEXT = `${STATUS_PREFIX}acceptance`;
const BASELINE_CONTEXT = `${STATUS_PREFIX}baseline`;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_OBSERVATION_AGE_MS = 30 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const OBSERVED_AT_SUFFIX = '; observed ';

function sourceContext(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('seed health problem needs a source name');
  }
  return `${STATUS_PREFIX}${encodeURIComponent(name)}`;
}

function validateAcceptance(acceptance) {
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
    throw new Error('seed acceptance observation must contain an acceptance object');
  }
  for (const key of ['blocking', 'acknowledged', 'cleared', 'escalated']) {
    if (!Array.isArray(acceptance[key])) {
      throw new Error(`seed acceptance ${key} must be an array`);
    }
  }
  if (typeof acceptance.expired !== 'boolean') {
    throw new Error('seed acceptance expired must be a boolean');
  }
  if (typeof acceptance.expiresAt !== 'string' || !Number.isFinite(Date.parse(acceptance.expiresAt))) {
    throw new Error('seed acceptance expiresAt must be an ISO date');
  }
  for (const [group, problems] of Object.entries({
    blocking: acceptance.blocking,
    acknowledged: acceptance.acknowledged,
    cleared: acceptance.cleared,
    escalated: acceptance.escalated,
  })) {
    for (const problem of problems) {
      if (!problem || typeof problem !== 'object' || Array.isArray(problem)) {
        throw new Error(`seed acceptance ${group} entries must be objects`);
      }
      if (typeof problem.name !== 'string' || problem.name.length === 0) {
        throw new Error(`seed acceptance ${group} entries need a source name`);
      }
      if (typeof problem.status !== 'string' || problem.status.length === 0) {
        throw new Error(`seed acceptance ${group} entries need a status`);
      }
      if (group !== 'blocking' && !Number.isInteger(problem.issue)) {
        throw new Error(`seed acceptance ${group} entries need an owner issue`);
      }
      if (group === 'blocking' && Object.hasOwn(problem, 'expiredEntry')) {
        if (typeof problem.expiredEntry !== 'string' || !Number.isFinite(Date.parse(problem.expiredEntry))) {
          throw new Error('expired seed acceptance entries need an ISO expiry');
        }
        if (!Number.isInteger(problem.issue)) {
          throw new Error('expired seed acceptance entries need an owner issue');
        }
      }
    }
  }
  return acceptance;
}

/** Convert the strict health split to stable, source-owned commit statuses. */
export function buildSeedHealthStatuses(rawAcceptance, checkedAt) {
  const acceptance = validateAcceptance(rawAcceptance);
  const activeCount = acceptance.blocking.length;
  let acceptanceState = 'success';
  let acceptanceDescription = 'ingestion operational acceptance passed';
  if (acceptance.expired) {
    acceptanceState = 'pending';
    acceptanceDescription = 'accepted-problem baseline requires review';
  } else if (activeCount > 0) {
    acceptanceState = 'pending';
    acceptanceDescription = `${activeCount} source incident${activeCount === 1 ? ' remains' : 's remain'} active`;
  }
  const statuses = [{
    context: ACCEPTANCE_CONTEXT,
    state: acceptanceState,
    description: checkedAt ? `${acceptanceDescription}${OBSERVED_AT_SUFFIX}${checkedAt}` : acceptanceDescription,
  }];

  for (const problem of acceptance.blocking) {
    statuses.push({
      context: sourceContext(problem.name),
      state: 'failure',
      // Deliberately exclude age and record count. They change every poll and
      // would turn one continuing outage into a new failed transition forever.
      description: Object.hasOwn(problem, 'expiredEntry')
        ? `${problem.status} acknowledgement expired (#${problem.issue})`
        : `${problem.status} blocks operational acceptance`,
    });
  }

  for (const problem of acceptance.acknowledged) {
    statuses.push({
      context: sourceContext(problem.name),
      // Acknowledgement is a workflow decision, not recovery. Keep the
      // per-source health projection non-green until compact health clears it.
      state: 'pending',
      description: `${problem.status} acknowledged by #${problem.issue}`,
    });
  }

  if (acceptance.expired) {
    statuses.push({
      context: BASELINE_CONTEXT,
      state: 'failure',
      description: `accepted-problem baseline expired on ${acceptance.expiresAt}`,
    });
  }

  return statuses;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.signal) throw new Error(`git ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function isAncestor(ancestor, descendant) {
  const args = ['merge-base', '--is-ancestor', ancestor, descendant];
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.signal) throw new Error(`git ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
}

export function validateObservationCheckedAt(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error('seed acceptance observation checkedAt must be a normalized UTC ISO instant');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error('seed acceptance observation checkedAt must be a valid normalized UTC ISO instant');
  }
  if (timestamp > now + MAX_FUTURE_SKEW_MS || timestamp < now - MAX_OBSERVATION_AGE_MS) {
    throw new Error('seed acceptance observation checkedAt is outside the allowed freshness window');
  }
  return timestamp;
}

function completionMarkerCheckedAt(status) {
  if (!status.description.includes(OBSERVED_AT_SUFFIX)) return null;
  const match = typeof status?.description === 'string'
    ? status.description.match(/; observed (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/)
    : null;
  if (!match) throw new Error('seed acceptance completion marker has a malformed observed checkedAt');
  const checkedAt = match[1];
  const timestamp = Date.parse(checkedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== checkedAt) {
    throw new Error('seed acceptance completion marker has an invalid observed checkedAt');
  }
  return { checkedAt, timestamp };
}

function statusMeaningMatches(current, previous) {
  if (!previous || current.state !== previous.state) return false;
  if (current.context !== ACCEPTANCE_CONTEXT) {
    return current.description === previous.description;
  }
  const withoutObservationTime = (description) => description.replace(
    /; observed \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    '',
  );
  return withoutObservationTime(current.description) === withoutObservationTime(previous.description);
}

function readObservation(path, now = Date.now()) {
  const observation = JSON.parse(readFileSync(path, 'utf8'));
  if (observation?.version !== 1) throw new Error('unsupported seed acceptance observation version');
  if (observation?.report?.failed !== true && observation?.report?.failed !== false) {
    throw new Error('seed acceptance observation must contain a boolean report.failed');
  }
  validateObservationCheckedAt(observation.checkedAt, now);
  const acceptance = validateAcceptance(observation.acceptance);
  const expectedFailure = acceptance.blocking.length > 0 || acceptance.expired;
  if (observation.report.failed !== expectedFailure) {
    throw new Error('seed acceptance observation verdict does not match its problem inventory');
  }
  return { ...observation, acceptance };
}

function firstParentShas(sha, limit) {
  const output = runGit(['log', '--first-parent', '-n', String(limit), '--format=%H', sha]);
  const shas = output.split('\n').filter(Boolean);
  if (shas[0] !== sha) throw new Error(`first-parent history did not start at ${sha}`);
  return shas;
}

function readPreviousObservation({ repository, shas, trustedWriter }) {
  for (const sha of shas) {
    const statuses = readCommitStatuses({ repository, sha });
    // The acceptance context is posted LAST. Finding it proves that the same
    // revision carries the complete per-source projection from one prior run
    // only when it is the NEWEST status in this namespace. A newer source
    // status above an older marker is a partial write and must be retried.
    // Stop here instead of spending one GitHub request on every ancestor.
    const newestSeedStatus = statuses.find(
      (status) => typeof status?.context === 'string' && status.context.startsWith(STATUS_PREFIX),
    );
    if (newestSeedStatus?.context === ACCEPTANCE_CONTEXT) {
      const projection = latestStatusesByContext([statuses], STATUS_PREFIX, { creatorLogin: trustedWriter });
      const marker = completionMarkerCheckedAt(projection.get(ACCEPTANCE_CONTEXT));
      // A trusted legacy marker lacks ordering information. Bootstrap once from
      // the live observation instead of letting legacy history suppress it.
      if (!marker) {
        return { sha: null, checkedAt: null, checkedAtTimestamp: null, statuses: new Map() };
      }
      return {
        sha,
        checkedAt: marker.checkedAt,
        checkedAtTimestamp: marker.timestamp,
        statuses: projection,
      };
    }
  }
  return { sha: null, checkedAt: null, checkedAtTimestamp: null, statuses: new Map() };
}

function readAnchorObservation({ repository, sha, trustedWriter }) {
  const statuses = readCommitStatuses({ repository, sha });
  const seedStatuses = statuses.filter(
    (status) => typeof status?.context === 'string' && status.context.startsWith(STATUS_PREFIX),
  );
  if (seedStatuses.length === 0) {
    return {
      state: 'empty',
      checkedAt: null,
      checkedAtTimestamp: null,
      statuses: new Map(),
    };
  }

  const projection = latestStatusesByContext([statuses], STATUS_PREFIX, { creatorLogin: trustedWriter });
  const markerStatus = projection.get(ACCEPTANCE_CONTEXT);
  const marker = markerStatus ? completionMarkerCheckedAt(markerStatus) : null;
  const newestIsMarker = seedStatuses[0].context === ACCEPTANCE_CONTEXT;
  // A pre-transition marker has no observation timestamp, so it cannot prove
  // ordering. Preserve the existing one-time bootstrap alert instead of using
  // legacy source statuses to suppress the first ordered projection.
  if (newestIsMarker && !marker) {
    return {
      state: 'legacy',
      checkedAt: null,
      checkedAtTimestamp: null,
      statuses: new Map(),
    };
  }
  return {
    state: newestIsMarker ? 'complete' : 'partial',
    checkedAt: marker?.checkedAt ?? null,
    checkedAtTimestamp: marker?.timestamp ?? null,
    statuses: projection,
  };
}

function isMainModule() {
  return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      report: { type: 'string' },
      sha: { type: 'string', default: process.env.GITHUB_SHA },
      'status-sha': { type: 'string', default: process.env.SEED_STATUS_SHA },
    },
    strict: true,
  });
  const reportPath = values.report;
  const observedSha = values.sha;
  const statusSha = values['status-sha'];
  const repository = process.env.GITHUB_REPOSITORY;
  if (!reportPath) throw new Error('--report is required');
  if (!observedSha) throw new Error('--sha or GITHUB_SHA is required');
  if (!statusSha) throw new Error('--status-sha or SEED_STATUS_SHA is required');
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  if (!isAncestor(statusSha, observedSha)) {
    throw new Error(`seed status anchor ${statusSha} is not an ancestor of monitored revision ${observedSha}`);
  }

  const observation = readObservation(reportPath);
  const current = buildSeedHealthStatuses(observation.acceptance, observation.checkedAt);
  const historyLimit = Number(process.env.SEED_STATUS_HISTORY_LIMIT ?? DEFAULT_HISTORY_LIMIT);
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 100) {
    throw new Error('SEED_STATUS_HISTORY_LIMIT must be an integer from 1 to 100');
  }
  const trustedWriter = requireStatusWriterLogin();
  const anchoredObservation = readAnchorObservation({
    repository,
    sha: statusSha,
    trustedWriter,
  });
  // The first anchored run imports the latest completed legacy projection from
  // main. A partial anchor write overlays that complete projection so the next
  // run repairs the projection without alerting again for a source status that
  // GitHub already accepted. Once the newest anchor status is its completion
  // marker, the anchor is the sole authority.
  const legacyObservation = anchoredObservation.state === 'complete'
    ? null
    : readPreviousObservation({
      repository,
      shas: firstParentShas(observedSha, historyLimit),
      trustedWriter,
    });
  const previousObservation = anchoredObservation.state === 'complete'
    ? { ...anchoredObservation, sha: statusSha }
    : {
        sha: legacyObservation.sha,
        checkedAt: anchoredObservation.checkedAt ?? legacyObservation.checkedAt,
        checkedAtTimestamp: anchoredObservation.checkedAtTimestamp
          ?? legacyObservation.checkedAtTimestamp,
        statuses: new Map([
          ...legacyObservation.statuses,
          ...anchoredObservation.statuses,
        ]),
      };
  if (previousObservation.checkedAtTimestamp != null
    && Date.parse(observation.checkedAt) <= previousObservation.checkedAtTimestamp) {
    throw new Error(`seed acceptance observation checkedAt ${observation.checkedAt} is not newer than completed projection ${previousObservation.checkedAt}`);
  }
  const plan = planStatusLifecycle({ current, previous: previousObservation.statuses });
  let updates = anchoredObservation.state === 'complete'
    ? plan.updates.filter(
        (status) => !statusMeaningMatches(status, anchoredObservation.statuses.get(status.context)),
      )
    : plan.updates;
  if (anchoredObservation.state === 'complete' && updates.length > 0
    && !updates.some((status) => status.context === ACCEPTANCE_CONTEXT)) {
    updates = [...updates, current.find((status) => status.context === ACCEPTANCE_CONTEXT)];
  }
  const orderedUpdates = [
    ...updates.filter((status) => status.context !== ACCEPTANCE_CONTEXT),
    ...updates.filter((status) => status.context === ACCEPTANCE_CONTEXT),
  ];
  postCommitStatuses({ repository, sha: statusSha, statuses: orderedUpdates });

  console.log(JSON.stringify({
    checkedAt: observation.checkedAt,
    observedSha,
    statusSha,
    anchorState: anchoredObservation.state,
    importedFromSha: anchoredObservation.state === 'complete' ? null : legacyObservation.sha,
    statusesPublished: orderedUpdates.length,
    newOrChangedFailures: plan.alerting.map((status) => status.context),
  }, null, 2));
  if (plan.alerting.length > 0) process.exitCode = 1;
}

if (process.argv[1] && isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
