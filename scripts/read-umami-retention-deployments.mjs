#!/usr/bin/env node

/**
 * Read the `umami-retention` deployment history for the runner check, without
 * the push refusals.
 *
 * Every push to main writes a SKIPPED refusal ("No changes to watched files")
 * for this service, while the deployment that decides health is written only
 * by a deploy and can be weeks old. `railway deployment list` returns refusals
 * too and caps at 1000 records, so on 2026-11-22 its window held 1000 refusals
 * and missed a 24-day-old active deployment that was ticking every 15 minutes.
 *
 * Railway's GraphQL `deployments` query filters by status on the server, so
 * excluding SKIPPED there makes the read depth independent of push volume.
 * `notIn` rather than an allow-list: a status Railway adds later still comes
 * back and trips the check's UNKNOWN_STATUS verdict instead of vanishing.
 *
 * Reads deployment records only. Never mutates Railway, never reads variables.
 */

import { parseArgs as parseNodeArgs } from 'node:util';

import {
  RETENTION_HISTORY_WINDOW,
  RETENTION_RUNNER_SERVICE,
} from './check-umami-retention-runner.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { parseRailwayApiOutput } from './railway-cli.mjs';
import { REJECTED_STATUS } from './railway-deployments.mjs';
import {
  RAILWAY_VOLUME_READ_POLICY,
  TRANSIENT_ERROR,
  runRailway,
  writeAtomically,
} from './read-railway-volumes.mjs';

const PROJECT_QUERY = `query RetentionTarget($projectId: String!) {
  project(id: $projectId) {
    environments { edges { node { id name } } }
    services { edges { node { id name } } }
  }
}`;

const DEPLOYMENTS_QUERY = `query RetentionDeployments($input: DeploymentListInput!, $first: Int) {
  deployments(input: $input, first: $first) {
    edges { node { id status createdAt } }
  }
}`;

function findByName(connection, name, kind) {
  const nodes = (connection?.edges ?? []).map((edge) => edge?.node).filter(Boolean);
  const match = nodes.find((node) => node.name === name);
  if (!match?.id) {
    throw new Error(
      `no ${kind} named ${name} in this Railway project (saw ${nodes.map((node) => node.name).join(', ') || 'none'})`,
    );
  }
  return match.id;
}

// One budget for the whole read, both calls and every retry. Two calls with
// two 100 s attempts each could spend ~400 s, and after the install, history
// restore and volume read the 12-minute job would be cancelled before the
// retention alarm prints. The CLI read this replaced was bounded by the CLI's
// own ~90 s request timeout; this leaves room for one retry on top of that.
export const RETENTION_READ_BUDGET_MS = 150_000;

/**
 * Run one GraphQL document through the Railway CLI, retrying a transport
 * failure as the volume read does (#8689), within the shared deadline. A bad
 * token or a GraphQL error fails at once.
 */
export async function railwayApi(query, variables, {
  policy = RAILWAY_VOLUME_READ_POLICY,
  run = runRailway,
  deadlineAt = Number.POSITIVE_INFINITY,
  now = Date.now,
} = {}) {
  const args = ['api', query, '--variables', JSON.stringify(variables), '--compact'];
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const remainingMs = deadlineAt - now();
    if (!(remainingMs > 0)) {
      throw new Error(`Railway API read deadline reached after ${attempt - 1} attempt(s)`);
    }
    const result = await run(args, Math.min(policy.attemptTimeoutMs, remainingMs));
    if (result.code === 0) return parseRailwayApiOutput(result.stdout);
    process.stderr.write(result.stderr);
    if (!result.timedOut && !TRANSIENT_ERROR.test(result.stderr)) {
      throw new Error(`railway api failed with exit code ${result.code}`);
    }
    console.error(`Railway API attempt ${attempt} could not reach Railway.`);
    const delayMs = Math.min(policy.retryDelayMs, deadlineAt - now());
    if (attempt < policy.attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`Railway API was unreachable on all ${policy.attempts} attempts`);
}

/** The newest non-refusal deployment records, newest first. */
export async function readRetentionDeployments({
  projectId,
  environment = 'production',
  service = RETENTION_RUNNER_SERVICE,
  window = RETENTION_HISTORY_WINDOW,
  now = Date.now,
  deadlineAt = now() + RETENTION_READ_BUDGET_MS,
  api = (query, variables) => railwayApi(query, variables, { deadlineAt, now }),
}) {
  if (!projectId) throw new Error('RAILWAY_PROJECT_ID is required');
  const target = await api(PROJECT_QUERY, { projectId });
  const environmentId = findByName(target?.project?.environments, environment, 'environment');
  const serviceId = findByName(target?.project?.services, service, 'service');

  const data = await api(DEPLOYMENTS_QUERY, {
    input: {
      projectId,
      environmentId,
      serviceId,
      status: { notIn: [REJECTED_STATUS] },
    },
    first: window,
  });
  const edges = data?.deployments?.edges;
  if (!Array.isArray(edges)) {
    throw new Error('Railway deployments must contain an edges array');
  }
  return edges.map((edge) => edge?.node);
}

async function main() {
  const { values } = parseNodeArgs({
    args: process.argv.slice(2),
    options: { output: { type: 'string' } },
    allowPositionals: false,
    strict: true,
  });
  if (!values.output) throw new Error('Provide the deployment history path with --output <path>');
  const rows = await readRetentionDeployments({ projectId: process.env.RAILWAY_PROJECT_ID });
  writeAtomically(values.output, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`Read ${rows.length} non-refusal ${RETENTION_RUNNER_SERVICE} deployment records.`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(`Retention deployment read failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
