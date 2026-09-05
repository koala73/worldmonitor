#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEnvFile } from './_seed-utils.mjs';
import { runRailway, runGit, resolveRailwayTarget, REPOSITORY } from './railway-cli.mjs';
import { orderByRecency, newestRunning } from './railway-deployments.mjs';
import { createAncestryResolver } from './railway-deploy-closure.mjs';

const SOURCES = {
  wildfires: {
    service: 'seed-fire-detections', metaKey: 'seed-meta:wildfire:fires',
    domain: 'wildfire', prefix: '', requiredRuns: 3,
    logFilter: '@event:seed_complete OR "Starting Container" OR "Run ID:" OR "[FIRMS]" OR "27 ok"',
  },
  physicalDivergence: {
    service: 'seed-bundle-macro', metaKey: 'seed-meta:market:physical-divergence',
    domain: 'market', prefix: 'Physical-Premiums', requiredRuns: 1,
    logFilter: '"Starting Container" OR "Physical-Premiums"',
  },
  crossStraitActivityTaiwanMnd: {
    service: 'seed-bundle-derived-signals', metaKey: 'seed-meta:military:cross-strait-activity:taiwan-mnd',
    sourceKey: 'military:cross-strait-activity:v1:source:taiwan-mnd',
    domain: 'military', prefix: 'Cross-Strait-Activity', requiredRuns: 2,
    logFilter: '"Starting Container" OR "Cross-Strait-Activity"',
  },
};
const HEALTH_URL = 'https://api.worldmonitor.app/api/health';
const MAX_LOG_LINES = 1000;
const SHA = /^[a-f0-9]{40}$/;
const CODE = /^[A-Z][A-Z0-9_:-]{0,99}$/;
const CAPTURE_ERRORS = new Set([
  'HEALTH_AUTH_MISSING', 'REDIS_AUTH_MISSING', 'REDIS_URL_INVALID', 'SERVICE_UNVERIFIED',
  'DEPLOYMENT_UNVERIFIED', 'SCHEDULE_UNVERIFIED', 'HEALTH_UNVERIFIED', 'SOURCE_METADATA_UNVERIFIED',
  'SOURCE_READ_UNVERIFIED', 'LOG_HISTORY_INCOMPLETE', 'LOG_EVIDENCE_INVALID',
  'READ_FAILED', 'AUTHENTICATION_FAILED', 'READ_INVALID_JSON',
]);
const fail = (code) => { throw new Error(code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = (value) => {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : NaN;
};
const iso = (value) => Number.isFinite(time(value)) ? new Date(time(value)).toISOString() : null;
const code = (value) => typeof value === 'string' && CODE.test(value) ? value : null;

export function validateRecord(record) {
  if (!object(record) || record.version !== 1 || !Object.hasOwn(SOURCES, record.source)
    || !SHA.test(record.requiredCommit) || !Number.isSafeInteger(record.pr) || record.pr < 1
    || !/^[\w .@-]{1,100}$/.test(record.owner ?? '')
    || !/^[a-f0-9-]{36}$/.test(record.project ?? '')
    || !iso(record.createdAt) || !iso(record.deadline) || time(record.deadline) <= time(record.createdAt)
    || !iso(record.baselineSuccessAt) || time(record.baselineSuccessAt) > time(record.createdAt)
    || !Array.isArray(record.observations) || record.observations.length > 1000) fail('INVALID_CHECKPOINT');
  let previous = time(record.createdAt) - 1;
  for (const observation of record.observations) {
    if (!object(observation) || !iso(observation.observedAt) || time(observation.observedAt) < previous) fail('INVALID_CHECKPOINT');
    previous = time(observation.observedAt);
  }
  return record;
}

export function projectSource(source, health, meta, detail, observedAt) {
  const now = time(observedAt);
  const entry = health?.checks?.[source];
  if (!object(entry) || !code(entry.status) || !iso(health.checkedAt)
    || now - time(health.checkedAt) > 300_000 || time(health.checkedAt) > now + 30_000) fail('HEALTH_UNVERIFIED');
  if (!object(meta) || !Number.isSafeInteger(meta.recordCount) || meta.recordCount < 0
    || !iso(meta.fetchedAt) || time(meta.fetchedAt) > now + 30_000
    || !['ok', 'error', 'degraded', 'blocked'].includes(meta.sourceState)) fail('SOURCE_METADATA_UNVERIFIED');
  const projected = {
    healthStatus: entry.status, healthCheckedAt: iso(health.checkedAt),
    recordCount: meta.recordCount, sourceState: meta.sourceState,
    lastSuccessAt: iso(meta.fetchedAt), lastAttemptAt: null,
    failureCode: code(meta.errorCode) ?? code(meta.lastSourceFailureCode),
  };
  if (source === 'wildfires') {
    const failures = meta.consecutiveSourceFailures ?? (meta.sourceState === 'ok' ? 0 : null);
    if (!Number.isSafeInteger(failures) || failures < 0) fail('SOURCE_METADATA_UNVERIFIED');
    projected.consecutiveSourceFailures = failures;
  }
  if (source === 'physicalDivergence') {
    if (!iso(meta.inputFreshUntil)) fail('SOURCE_METADATA_UNVERIFIED');
    projected.inputFreshUntil = iso(meta.inputFreshUntil);
  }
  if (source === 'crossStraitActivityTaiwanMnd') {
    if (!object(detail) || !iso(detail.lastSuccessAt) || !iso(detail.lastAttemptAt)
      || time(detail.lastAttemptAt) > now + 30_000 || time(detail.lastSuccessAt) > time(detail.lastAttemptAt)
      || time(detail.lastSuccessAt) !== time(meta.fetchedAt)
      || !['fresh', 'error', 'stale', 'blocked'].includes(detail.transportStatus)) fail('SOURCE_METADATA_UNVERIFIED');
    projected.lastSuccessAt = iso(detail.lastSuccessAt);
    projected.lastAttemptAt = iso(detail.lastAttemptAt);
    projected.transportStatus = detail.transportStatus;
    projected.failureCode = detail.errorCodes?.map(code).find(Boolean) ?? null;
  }
  return projected;
}

function scheduledStart(timestamp, cron) {
  const date = new Date(timestamp);
  const minute = date.getUTCMinutes();
  if (cron === '*/10 * * * *') return minute % 10 < 5;
  if (cron === '*/5 * * * *') return minute % 5 < 2;
  if (cron === '0 8,9 * * *') return [8, 9].includes(date.getUTCHours()) && minute < 5;
  return false;
}

export function projectRuns(source, logs, deployment, observedAt) {
  if (!Array.isArray(logs) || logs.length >= MAX_LOG_LINES) fail('LOG_HISTORY_INCOMPLETE');
  const config = SOURCES[source];
  const starts = logs.filter((row) => row.message === 'Starting Container' && iso(row.timestamp));
  const attempts = logs.flatMap((row) => {
    if (typeof row.message !== 'string' || (config.prefix && !row.message.includes(`[${config.prefix}]`))) return [];
    const match = row.message.match(/Run ID:\s+(\d{13})-[a-z0-9]+\s*$/);
    return match ? [Number(match[1])] : [];
  });
  const runs = [];
  for (const row of logs) {
    let event = row;
    if (config.prefix) {
      const match = typeof row.message === 'string' && row.message.match(/^\s*\[([^\]]+)\]\s*(\{.*\})$/);
      if (!match || match[1] !== config.prefix) continue;
      try { event = JSON.parse(match[2]); } catch { fail('LOG_EVIDENCE_INVALID'); }
    }
    if (event.event !== 'seed_complete' || event.domain !== config.domain) continue;
    if (!iso(event.timestamp) || !Number.isSafeInteger(event.durationMs) || event.durationMs <= 0
      || event.durationMs > (source === 'wildfires' ? 3_600_000 : 570_000) || !code(event.state)) fail('LOG_EVIDENCE_INVALID');
    const ended = time(event.timestamp);
    const started = ended - event.durationMs;
    if (ended > time(observedAt) + 30_000) fail('LOG_EVIDENCE_INVALID');
    const container = starts.filter((start) => {
      const delta = started - time(start.timestamp);
      return delta >= -15_000 && delta <= (config.prefix ? 570_000 : 120_000);
    }).sort((a, b) => time(b.timestamp) - time(a.timestamp))[0];
    const inRun = (line) => time(line.timestamp) >= started - 15_000 && time(line.timestamp) <= ended + 15_000;
    runs.push({
      startedAt: new Date(started).toISOString(), completedAt: iso(event.timestamp), state: event.state,
      containerStartedAt: iso(container?.timestamp),
      scheduled: Boolean(container && scheduledStart(time(container.timestamp), deployment.cronSchedule)),
      completeCoverage: source !== 'wildfires' || logs.some((line) => inRun(line) && /\(27 ok, 0 failed\)/.test(line.message)),
      recoveryPath: source === 'wildfires' && logs.some((line) => inRun(line) && /; trying primary retry$/.test(line.message)),
    });
  }
  for (const started of attempts) {
    if (!runs.some((run) => Math.abs(time(run.startedAt) - started) < 1000)) {
      runs.push({ startedAt: new Date(started).toISOString(), completedAt: null, state: 'INCOMPLETE' });
    }
  }
  return runs.sort((a, b) => time(a.startedAt) - time(b.startedAt));
}

export function evaluateRecovery(record) {
  validateRecord(record);
  let verdict = { status: 'waiting_for_deployment', reason: 'FIX_NOT_ACTIVE', successfulRuns: 0 };
  let sequence = [];
  let deploymentId = null;
  let confirmedAt = null;
  let lastSuccess = record.baselineSuccessAt;
  for (const observation of record.observations) {
    if (['passed', 'failed'].includes(verdict.status)) break;
    if (time(observation.observedAt) > time(record.deadline)) {
      verdict = { ...verdict, status: 'failed', reason: `DEADLINE:${verdict.reason}` };
      break;
    }
    const result = (status, reason) => ({ status, reason, successfulRuns: sequence.length });
    if (observation.error || !observation.deployment || !observation.source || !Array.isArray(observation.runs)) {
      sequence = [];
      verdict = result('unverified', code(observation.error) ?? 'OBSERVATION_UNVERIFIED');
    } else {
      const { deployment, source, runs } = observation;
      if (deployment.id !== deploymentId && deployment.ancestry === 'yes') {
        sequence = [];
        deploymentId = deployment.id;
        confirmedAt = observation.observedAt;
      }
      if (deployment.ancestry !== 'yes') {
        sequence = [];
        deploymentId = null;
        confirmedAt = null;
        verdict = result(deployment.ancestry === 'no' ? 'waiting_for_deployment' : 'unverified', 'FIX_NOT_VERIFIED_ACTIVE');
      } else if (!SHA.test(deployment.commit) || !deployment.id || !iso(deployment.createdAt)
        || !iso(source.lastSuccessAt) || !iso(source.healthCheckedAt)
        || time(observation.observedAt) - time(source.healthCheckedAt) > 300_000
        || time(source.healthCheckedAt) > time(observation.observedAt) + 30_000
        || !Number.isSafeInteger(source.recordCount) || source.recordCount < 1
        || (record.source === 'physicalDivergence' && !iso(source.inputFreshUntil))
        || time(source.lastSuccessAt) > time(observation.observedAt) + 30_000) {
        sequence = [];
        verdict = result('unverified', 'SOURCE_TIME_INVALID');
      } else if (source.healthStatus !== 'OK' || source.sourceState !== 'ok'
        || (record.source === 'wildfires' && source.consecutiveSourceFailures !== 0)
        || (record.source === 'physicalDivergence' && (source.recordCount !== 2 || time(source.inputFreshUntil) <= time(observation.observedAt)))
        || (record.source === 'crossStraitActivityTaiwanMnd' && (source.transportStatus !== 'fresh' || source.failureCode))) {
        sequence = [];
        if (source.sourceState !== 'ok' || source.failureCode) lastSuccess = source.lastSuccessAt;
        verdict = result('waiting_for_run', source.failureCode ?? 'SOURCE_NOT_HEALTHY');
      } else if (time(source.lastSuccessAt) <= time(lastSuccess) || time(source.lastSuccessAt) <= time(record.baselineSuccessAt)) {
        if (sequence.length && runs.some((run) => time(run.completedAt) > time(sequence.at(-1).completedAt))) sequence = [];
        verdict = result(sequence.length ? 'observing' : 'waiting_for_run', 'SUCCESS_NOT_ADVANCED');
      } else {
        const matched = runs.filter((run) => time(source.lastSuccessAt) >= time(run.startedAt)
          && time(source.lastSuccessAt) <= time(run.completedAt) + 15_000);
        const run = matched.length === 1 ? matched[0] : null;
        if (!run || run.scheduled !== true || run.state !== 'OK' || run.completeCoverage !== true
          || !iso(run.containerStartedAt) || !iso(run.startedAt) || !iso(run.completedAt)
          || time(run.startedAt) <= time(confirmedAt) || time(run.completedAt) > time(record.deadline)) {
          sequence = [];
          verdict = result('unverified', 'NATURAL_SOURCE_RUN_UNVERIFIED');
        } else {
          const previousRun = sequence.at(-1);
          if (previousRun && (time(run.completedAt) <= time(previousRun.completedAt)
            || time(run.containerStartedAt) <= time(previousRun.containerStartedAt)
            || (record.source === 'crossStraitActivityTaiwanMnd' && time(run.startedAt) - time(previousRun.startedAt) < 10_500_000))) {
            sequence = [];
            verdict = result('unverified', 'DISTINCT_SOURCE_RUN_UNVERIFIED');
            continue;
          }
          if (previousRun && (!runs.some((other) => other.completedAt === previousRun.completedAt)
            || runs.some((other) => time(other.startedAt) > time(previousRun.completedAt)
              && time(other.startedAt) < time(run.startedAt)))) sequence = [];
          sequence.push({ ...run, lastSuccessAt: source.lastSuccessAt });
          lastSuccess = source.lastSuccessAt;
          const enough = sequence.length >= SOURCES[record.source].requiredRuns;
          const recoveryPath = record.source !== 'wildfires' || sequence.some((item) => item.recoveryPath);
          verdict = result(enough && recoveryPath ? 'passed' : 'observing',
            !recoveryPath ? 'RECOVERY_PATH_NOT_OBSERVED' : enough ? 'SOURCE_RECOVERY_PROVED' : 'MORE_RUNS_REQUIRED');
        }
      }
    }
    if (time(observation.observedAt) >= time(record.deadline) && verdict.status !== 'passed') {
      verdict = { ...verdict, status: 'failed', reason: `DEADLINE:${verdict.reason}` };
    }
  }
  return { ...verdict, requiredRuns: SOURCES[record.source].requiredRuns };
}

async function readJson(url, options, fetchFn) {
  let response;
  try { response = await fetchFn(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { fail('READ_FAILED'); }
  if (!response.ok) fail([401, 403].includes(response.status) ? 'AUTHENTICATION_FAILED' : 'READ_FAILED');
  try { return await response.json(); } catch { fail('READ_INVALID_JSON'); }
}

export async function captureObservation(record, {
  fetchFn = (...args) => globalThis.fetch(...args), railway = runRailway, git = runGit,
  env = process.env, now = Date.now(),
} = {}) {
  const observedAt = new Date(now).toISOString();
  const observation = { observedAt };
  const config = SOURCES[record.source];
  let stage = 'DEPLOYMENT_READ_FAILED';
  try {
    if (!env.WM_API_KEY && !env.WORLDMONITOR_API_KEY) fail('HEALTH_AUTH_MISSING');
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) fail('REDIS_AUTH_MISSING');
    const redisUrl = new URL(env.UPSTASH_REDIS_REST_URL);
    if (redisUrl.protocol !== 'https:' || redisUrl.username || redisUrl.password || redisUrl.search || redisUrl.hash) fail('REDIS_URL_INVALID');
    const status = JSON.parse(railway(['status', '--project', record.project, '--environment', 'production', '--json'], { timeout: 20_000 }));
    const { environmentId } = resolveRailwayTarget(status, record.project, 'production');
    const environment = status.environments.edges.find(({ node }) => node.id === environmentId).node;
    const services = environment.serviceInstances?.edges?.map(({ node }) => node).filter((node) => node.serviceName === config.service);
    if (services?.length !== 1 || services[0].source?.repo !== REPOSITORY) fail('SERVICE_UNVERIFIED');
    const service = services[0];
    const active = orderByRecency(service.activeDeployments ?? []);
    const deployed = newestRunning(active);
    if (active.length !== 1 || !deployed || !SHA.test(deployed.meta?.commitHash)
      || deployed.meta?.repo !== REPOSITORY || deployed.meta?.branch !== 'main'
      || !iso(deployed.createdAt) || time(deployed.createdAt) > now + 30_000) fail('DEPLOYMENT_UNVERIFIED');
    const registry = JSON.parse(readFileSync(new URL('./railway-services.json', import.meta.url), 'utf8'));
    const expectedCron = registry.find((entry) => entry.service === config.service)?.cronSchedule;
    if (!expectedCron || service.cronSchedule !== expectedCron
      || deployed.meta?.serviceManifest?.deploy?.cronSchedule !== expectedCron) fail('SCHEDULE_UNVERIFIED');
    observation.deployment = {
      id: deployed.id, commit: deployed.meta.commitHash, createdAt: iso(deployed.createdAt),
      project: record.project, environment: environmentId, service: config.service,
      cronSchedule: expectedCron,
      ancestry: createAncestryResolver({ git })(record.requiredCommit, deployed.meta.commitHash),
    };
    stage = 'HEALTH_READ_FAILED';
    const health = await readJson(HEALTH_URL, { headers: {
      'X-WorldMonitor-Key': env.WORLDMONITOR_API_KEY || env.WM_API_KEY,
      'User-Agent': 'WorldMonitor-seed-recovery/1.0',
    } }, fetchFn);
    stage = 'METADATA_READ_FAILED';
    const keys = [config.metaKey, ...(config.sourceKey ? [config.sourceKey] : [])];
    const rows = await readJson(new URL('/pipeline', redisUrl), {
      method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'WorldMonitor-seed-recovery/1.0' },
      body: JSON.stringify(keys.map((key) => ['GET', key])),
    }, fetchFn);
    if (!Array.isArray(rows) || rows.length !== keys.length || rows.some((row) => row.error || typeof row.result !== 'string')) fail('SOURCE_READ_UNVERIFIED');
    const [meta, detail] = rows.map((row) => JSON.parse(row.result));
    observation.source = projectSource(record.source, health, meta, detail, observedAt);
    stage = 'LOG_READ_FAILED';
    const rawLogs = railway(['logs', deployed.id, '--project', record.project, '--environment', 'production',
      '--service', config.service, '--since', record.createdAt, '--until', observedAt,
      '--lines', String(MAX_LOG_LINES), '--filter', config.logFilter, '--json'], { timeout: 20_000 });
    const logs = rawLogs.trim() ? rawLogs.trim().split('\n').map((line) => JSON.parse(line)) : [];
    observation.runs = projectRuns(record.source, logs, observation.deployment, observedAt);
  } catch (error) {
    observation.error = CAPTURE_ERRORS.has(error.message) ? error.message : stage;
  }
  return observation;
}

export function formatRecoveryMarkdown(record) {
  const verdict = evaluateRecovery(record);
  const last = record.observations.at(-1);
  return [
    `# ${record.source} recovery`, '',
    `Verdict: **${verdict.status}** (${verdict.reason}).`, '',
    `Repair: #${record.pr}; required commit: ${record.requiredCommit}; owner: ${record.owner}.`, '',
    `Baseline success: ${record.baselineSuccessAt}. Fixed deadline: ${record.deadline}.`, '',
    `Distinct consecutive source runs: ${verdict.successfulRuns}/${verdict.requiredRuns}.`, '',
    `Latest observation: ${last?.observedAt ?? 'none'}; health: ${last?.source?.healthStatus ?? 'unverified'}.`, '',
    `Deployment: ${last?.deployment?.id ?? 'unverified'}; commit: ${last?.deployment?.commit ?? 'unverified'}; ancestry: ${last?.deployment?.ancestry ?? 'unknown'}.`, '',
    'Scheduled execution attribution requires a container start in the configured cron window and a matching source completion. The member due time remains unknown until execution evidence exists. Do not run manual seeds during this observation window.', '',
    ...(record.source === 'physicalDivergence' ? ['This verdict covers initial recovery only. The separate 48-hour macro schedule validation remains required, including two 09:00 UTC ticks.', ''] : []),
    'The JSON checkpoint is the evidence record. Capturing an observation does not mean acceptance passed.', '',
  ].join('\n');
}

function atomicWrite(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { values } = parseArgs({ args: argv, options: Object.fromEntries(
    ['source', 'required-commit', 'pr', 'owner', 'project', 'deadline', 'output', 'resume'].map((name) => [name, { type: 'string' }]),
  ) });
  const output = resolve(values.output ?? values.resume ?? fail('OUTPUT_REQUIRED'));
  if (!output.endsWith('.json')) fail('OUTPUT_MUST_BE_JSON');
  if (existsSync(output) && (!values.resume || output !== resolve(values.resume))) fail('CHECKPOINT_EXISTS_USE_RESUME');
  let record;
  if (values.resume) {
    record = validateRecord(JSON.parse(readFileSync(values.resume, 'utf8')));
    for (const [flag, field] of Object.entries({ source: 'source', 'required-commit': 'requiredCommit', pr: 'pr', owner: 'owner', project: 'project', deadline: 'deadline' })) {
      if (values[flag] !== undefined && String(values[flag]) !== String(record[field])) fail('CHECKPOINT_IDENTITY_MISMATCH');
    }
  } else {
    const now = new Date(dependencies.now ?? Date.now()).toISOString();
    record = validateRecord({ version: 1, source: values.source, requiredCommit: values['required-commit'],
      pr: Number(values.pr), owner: values.owner, project: values.project, createdAt: now,
      deadline: values.deadline, baselineSuccessAt: now, observations: [] });
  }
  const observation = await captureObservation(record, dependencies);
  if (!values.resume) {
    if (!observation.source?.lastSuccessAt || time(observation.source.lastSuccessAt) > time(record.createdAt)) fail(observation.error ?? 'BASELINE_UNVERIFIED');
    record.baselineSuccessAt = observation.source.lastSuccessAt;
  }
  record.observations.push(observation);
  record.verdict = evaluateRecovery(record);
  atomicWrite(output, `${JSON.stringify(record, null, 2)}\n`);
  atomicWrite(output.replace(/\.json$/, '.md'), formatRecoveryMarkdown(record));
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile(import.meta.url, { only: ['WM_API_KEY', 'WORLDMONITOR_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] });
  main().then((record) => {
    console.log(`${record.source}: ${record.verdict.status} (${record.verdict.reason})`);
    process.exitCode = record.verdict.status === 'passed' ? 0 : ['failed', 'unverified'].includes(record.verdict.status) ? 1 : 2;
  }).catch((error) => {
    const reason = CAPTURE_ERRORS.has(error.message) || /^(?:BASELINE_UNVERIFIED|(?:DEPLOYMENT|HEALTH|METADATA|LOG)_READ_FAILED)$/.test(error.message)
      ? error.message : 'INVALID_ARGUMENTS_OR_CHECKPOINT';
    console.error(`Recovery capture failed: ${reason}. No acceptance was proved.`);
    process.exitCode = 1;
  });
}
