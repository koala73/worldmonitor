#!/usr/bin/env node

/**
 * Runtime health of the Railway `umami-retention` cron service.
 *
 * The capacity monitor next to this file measures the volume, which is a
 * lagging signal: when the retention runner died, the volume took days to
 * drift into the warning band, and the warning is deliberately non-fatal
 * (#6384), so nothing ever failed. #6375 was that gap — the runner exited
 * non-zero on every 15-minute tick for days while every dashboard stayed
 * green, because `scripts/railway-deployments.mjs` counts CRASHED as "the
 * image ran" (true, and the right answer for a source-drift audit) and this
 * cron service had no runtime health check of its own.
 *
 * This check reads deployment records only. It never connects to Postgres,
 * never mutates Railway, and prints no Railway variables.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseArgs as parseNodeArgs } from 'node:util';

import { isMainModule } from './lib/main-module.mjs';
import {
  REJECTED_STATUS,
  createdAtMs,
  isKnownStatus,
  newestRunning,
  orderByRecency,
} from './railway-deployments.mjs';

export const RETENTION_RUNNER_SERVICE = 'umami-retention';

// Deep enough that ordinary push traffic cannot bury the record that decides
// health. A cron tick does NOT create a deployment record — it re-runs the
// active one — so the record we need is written only by a deploy or redeploy
// and can be days old while the service is perfectly healthy. Meanwhile every
// push to main writes a SKIPPED refusal for this service ("No changes to
// watched files"), so refusals accumulate and the record we want sinks. Depth
// is the only defence, and it costs the same single CLI call either way.
export const RETENTION_HISTORY_WINDOW = 200;

export function normalizeDeploymentRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.deployments)) return payload.deployments;
  return null;
}

/**
 * Decide whether the retention runner is healthy from its deployment history.
 *
 * Fails closed: anything this cannot read, recognise, or prove is alarming.
 * A silent pass here re-creates the exact failure it exists to catch.
 */
export function evaluateRetentionRunner(payload) {
  const rows = normalizeDeploymentRows(payload);
  if (rows === null) {
    return {
      verdict: 'UNREADABLE',
      alarming: true,
      detail: 'Railway returned no deployment array for the retention runner',
    };
  }
  if (rows.length === 0) {
    return {
      verdict: 'NO_DEPLOYMENTS',
      alarming: true,
      detail: 'Railway returned an empty deployment history for the retention runner',
    };
  }

  const ordered = orderByRecency(rows);
  const running = newestRunning(ordered);

  // Only an unmodelled status NEWER than the selected record can change the
  // verdict, by hiding a record that should have been chosen instead. Scanning
  // the whole window instead would let one stale `REMOVING` — the transition
  // every superseded deployment passes through — hold the alarm red forever
  // over a record that has no bearing on the answer.
  const runningAtMs = running ? createdAtMs(running) : Number.NEGATIVE_INFINITY;
  const unknown = ordered.find(
    (row) => !isKnownStatus(row?.status) && createdAtMs(row) >= runningAtMs,
  );
  if (unknown) {
    return {
      verdict: 'UNKNOWN_STATUS',
      alarming: true,
      detail: `Railway reported an unmodelled deployment status ${JSON.stringify(unknown?.status ?? null)} `
        + 'newer than the newest record that ran, so which record decides health is a guess',
    };
  }

  if (!running) {
    const refusals = ordered.filter((row) => row?.status === REJECTED_STATUS).length;
    return {
      verdict: 'NO_RUNNING_DEPLOYMENT',
      alarming: true,
      detail: `none of the newest ${ordered.length} records reached a running state `
        + `(${refusals} were ${REJECTED_STATUS} refusals)`,
    };
  }

  // A record carrying a status and nothing else is not evidence of a healthy
  // tick, it is a truncated read. Without this, `[{"status":"SUCCESS"}]` exits
  // 0 and reports HEALTHY — a green alarm built on a record that identifies no
  // deployment and names no time.
  const identified = typeof running.id === 'string' && running.id.length > 0;
  const timed = Number.isFinite(Date.parse(running.createdAt ?? ''));
  if (!identified || !timed) {
    return {
      verdict: 'INCOMPLETE_RECORD',
      alarming: true,
      status: running.status,
      detail: 'the newest running deployment record is missing its id or a parseable createdAt, '
        + 'so it cannot be trusted as proof a tick ran',
    };
  }

  const crashed = running.status === 'CRASHED';
  return {
    verdict: crashed ? 'CRASHED' : 'HEALTHY',
    alarming: crashed,
    deploymentId: running.id ?? null,
    status: running.status,
    createdAt: running.createdAt ?? null,
    // Precise, because this sentence is what someone reads at 03:00. The tick
    // no longer runs in one transaction, so a crash does NOT mean nothing was
    // retired — statements that committed before the failure stand, and every
    // statement after it never ran. The tick is partial, not void.
    detail: crashed
      ? 'the newest retention tick exited non-zero: statements before the failure committed, '
        + 'statements after it never ran, so the tick retired less than a full pass'
      : 'the newest retention deployment that ran did not crash',
  };
}

function readJson(path) {
  const raw = readFileSync(path, 'utf8');
  // The workflow's `railway ... > file` redirect creates the file before the
  // CLI runs, so a Railway-side failure leaves an empty or half-written file
  // rather than no file. Bare `JSON.parse` then reports "Unexpected end of
  // JSON input", which sends the reader looking for a bug in this check
  // instead of at the step above it.
  if (raw.trim() === '') {
    throw new Error(
      `${path} is empty — the Railway read that writes it did not complete; `
        + 'check the "Read retention runner deployments" step for the real error',
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON (${error.message}) — it is most likely a truncated `
        + 'Railway response; check the "Read retention runner deployments" step',
    );
  }
}

export function parseArguments(argv) {
  const { values } = parseNodeArgs({
    args: argv,
    options: { input: { type: 'string' } },
    allowPositionals: false,
    strict: true,
  });
  return values;
}

function describe(result) {
  const where = result.deploymentId
    ? ` (deployment ${result.deploymentId}, status ${result.status}, created ${result.createdAt})`
    : '';
  return `Umami retention runner ${result.verdict}: ${result.detail}${where}.`;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const inputPath = args.input || process.env.UMAMI_RETENTION_INPUT;
  if (!inputPath) {
    throw new Error('Provide Railway deployment JSON with --input <path> or UMAMI_RETENTION_INPUT');
  }
  if (!existsSync(inputPath)) throw new Error(`Retention deployment input not found: ${inputPath}`);

  const result = evaluateRetentionRunner(readJson(inputPath));
  console.log(describe(result));
  if (result.alarming) {
    // Only CRASHED is a statement about the database. The other alarming
    // verdicts mean we could not read Railway well enough to judge — an
    // expired token, an API blip, a renamed service, a status we do not model.
    // Both fail the run, but telling an operator "Postgres will fill" when the
    // truth is "the token expired" is how an alarm loses its audience.
    const consequence = result.verdict === 'CRASHED'
      ? `The ${RETENTION_RUNNER_SERVICE} cron service is failing, so Umami Postgres will fill until it is fixed.`
      : `Could not establish whether ${RETENTION_RUNNER_SERVICE} is retiring rows, so it is unobserved.`;
    console.error(`::error::${result.verdict}: ${result.detail}. ${consequence}`);
    process.exitCode = 1;
  }
}

const isMain = isMainModule(import.meta.url, process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(
      `Umami retention runner check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
