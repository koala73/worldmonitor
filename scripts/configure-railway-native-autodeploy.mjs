#!/usr/bin/env node

// TEMPORARY CUTOVER UTILITY — delete after the bounded rollback window in U6.
//
// Preview is the default. Mutation is deliberately narrower than Railway's
// configuration surface: at most five explicitly named services, and the only
// patch field is source.checkSuites. This file must never become a workflow or
// receive GitHub/control-plane credentials.

import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  auditRailwayServiceConfig,
} from './audit-railway-watch-paths.mjs';
import {
  createRailwayCliEnv,
  isRepositoryService,
  REPOSITORY,
  resolveRailwayTarget,
  runRailway,
} from './railway-cli.mjs';

const REGISTRY_URL = new URL('./railway-services.json', import.meta.url);
const DEFAULT_READBACK_ATTEMPTS = 10;
const DEFAULT_READBACK_DELAY_MS = 1_000;

export const MAX_BATCH_SIZE = 5;

function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function inlineValue(argument, name) {
  if (!argument.startsWith(`${name}=`)) return null;
  const value = argument.slice(name.length + 1);
  if (value.length === 0) throw new Error(`${name} requires a value`);
  return value;
}

function environmentMarkerEnabled(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && !['0', 'false', 'no', 'off'].includes(normalized);
}

export function parseMigrationArgs(argv) {
  let projectId = null;
  let environment = null;
  let apply = false;
  let rollback = false;
  let json = false;
  const services = [];

  const setOnce = (name, current, value) => {
    if (current !== null) throw new Error(`${name} may be provided only once`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const inlineProject = inlineValue(argument, '--project-id');
    if (inlineProject !== null) {
      projectId = setOnce('--project-id', projectId, inlineProject);
      continue;
    }
    const inlineEnvironment = inlineValue(argument, '--environment');
    if (inlineEnvironment !== null) {
      environment = setOnce('--environment', environment, inlineEnvironment);
      continue;
    }
    const inlineService = inlineValue(argument, '--service');
    if (inlineService !== null) {
      services.push(inlineService);
      continue;
    }

    switch (argument) {
      case '--project-id':
        projectId = setOnce('--project-id', projectId, requireValue(argv, index, argument));
        index += 1;
        break;
      case '--environment':
        environment = setOnce('--environment', environment, requireValue(argv, index, argument));
        index += 1;
        break;
      case '--service':
        services.push(requireValue(argv, index, argument));
        index += 1;
        break;
      case '--apply':
        if (apply) throw new Error('--apply may be provided only once');
        apply = true;
        break;
      case '--rollback':
        if (rollback) throw new Error('--rollback may be provided only once');
        rollback = true;
        break;
      case '--json':
        if (json) throw new Error('--json may be provided only once');
        json = true;
        break;
      default:
        throw new Error(`unknown argument ${argument}`);
    }
  }

  if (!projectId) throw new Error('--project-id is required');
  if (!environment) throw new Error('--environment is required');
  if (apply && rollback) throw new Error('--apply and --rollback are mutually exclusive');

  const seen = new Set();
  for (const service of services) {
    if (seen.has(service)) throw new Error(`duplicate service ${service}`);
    seen.add(service);
  }
  if (services.length > MAX_BATCH_SIZE) {
    throw new Error(`select at most ${MAX_BATCH_SIZE} services per mutation batch`);
  }

  const mode = apply ? 'apply' : rollback ? 'rollback' : 'preview';
  if (mode !== 'preview' && services.length === 0) {
    throw new Error(`${mode} requires at least one --service`);
  }

  return {
    mode,
    projectId,
    environment,
    services,
    json,
  };
}

function parseJsonPayload(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function checkSuitesState(source, name) {
  if (!Object.hasOwn(source, 'checkSuites') || source.checkSuites == null) return 'missing';
  if (typeof source.checkSuites !== 'boolean') {
    throw new Error(`${name} source.checkSuites must be boolean or missing`);
  }
  return source.checkSuites;
}

function requireServiceRecord(service) {
  if (!service || typeof service !== 'object' || Array.isArray(service)
    || typeof service.id !== 'string' || service.id.length === 0
    || typeof service.name !== 'string' || service.name.length === 0) {
    throw new Error('Railway service list contains a malformed service record');
  }
}

function assertExpectedRepository(source, name) {
  const repository = source?.repo;
  if (repository != null && repository !== REPOSITORY) {
    throw new Error(`${name} source repository differs from ${REPOSITORY}`);
  }
}

function inspectFleet(serviceList, config) {
  if (!Array.isArray(serviceList)) {
    throw new Error('Railway service list must return an array');
  }
  if (!config?.services || typeof config.services !== 'object' || Array.isArray(config.services)) {
    throw new Error('Railway environment config must contain a services object');
  }

  const byName = new Map();
  const byId = new Map();
  for (const service of serviceList) {
    requireServiceRecord(service);
    assertExpectedRepository(service.source, service.name);
    if (byName.has(service.name)) throw new Error(`duplicate live service name ${service.name}`);
    if (byId.has(service.id)) throw new Error(`duplicate live service id ${service.id}`);
    byName.set(service.name, service);
    byId.set(service.id, service);
  }

  for (const [serviceId, serviceConfig] of Object.entries(config.services)) {
    const listed = byId.get(serviceId);
    assertExpectedRepository(serviceConfig?.source, listed?.name ?? serviceId);
    if (!isRepositoryService(serviceConfig)) continue;
    if (!listed) {
      throw new Error(`Railway config contains repository service ${serviceId} missing from service list`);
    }
    if (!isRepositoryService(listed)) {
      throw new Error(`${listed.name} source repository differs between service list and config`);
    }
  }

  const repositoryServices = [];
  for (const service of serviceList) {
    if (!isRepositoryService(service)) continue;
    if (service.source.image != null) {
      throw new Error(`${service.name} has contradictory repository and image sources`);
    }
    const live = config.services[service.id];
    if (!live || typeof live !== 'object' || Array.isArray(live)) {
      throw new Error(`${service.name} is missing from Railway environment config`);
    }
    const source = live.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`${service.name} has an unknown Railway source shape`);
    }
    if (source.repo !== REPOSITORY) {
      throw new Error(`${service.name} source repository differs between service list and config`);
    }
    if (source.image != null) {
      throw new Error(`${service.name} has contradictory repository and image sources in Railway config`);
    }
    if (source.branch !== 'main') {
      throw new Error(`${service.name} source branch is ${String(source.branch ?? 'missing')}; expected main`);
    }
    repositoryServices.push({
      id: service.id,
      name: service.name,
      checkSuites: checkSuitesState(source, service.name),
    });
  }

  return { byName, repositoryServices };
}

function selectServices(fleet, names) {
  const repositoryByName = new Map(fleet.repositoryServices.map((service) => [service.name, service]));
  return names.map((name) => {
    const live = fleet.byName.get(name);
    if (!live) throw new Error(`unknown Railway service ${name}`);
    if (!isRepositoryService(live)) {
      throw new Error(`${name} is not sourced from ${REPOSITORY}`);
    }
    const selected = repositoryByName.get(name);
    if (!selected) throw new Error(`${name} has an unknown repository source shape`);
    return selected;
  });
}

function fleetSummary(repositoryServices) {
  const checkSuites = { true: 0, false: 0, missing: 0 };
  for (const service of repositoryServices) {
    checkSuites[String(service.checkSuites)] += 1;
  }
  return {
    repositoryServices: repositoryServices.length,
    checkSuites,
  };
}

export function buildCheckSuitesPatch(selected, value) {
  if (typeof value !== 'boolean') throw new Error('checkSuites patch value must be boolean');
  const entries = [];
  const seen = new Set();
  for (const service of selected) {
    if (!service?.id || seen.has(service.id)) {
      throw new Error('selected services must have unique Railway ids');
    }
    seen.add(service.id);
    entries.push([service.id, { source: { checkSuites: value } }]);
  }
  return { services: Object.fromEntries(entries) };
}

function serializePatch(selected, value) {
  // Railway commits a piped JSON patch only after the terminating newline.
  return `${JSON.stringify(buildCheckSuitesPatch(selected, value))}\n`;
}

function cloneJson(value) {
  return structuredClone(value);
}

function assertReadbackInvariants(before, after, selected) {
  if (!after?.services || typeof after.services !== 'object' || Array.isArray(after.services)) {
    throw new Error('Railway readback must contain a services object');
  }
  const beforeIds = Object.keys(before.services).sort();
  const afterIds = Object.keys(after.services).sort();
  if (!isDeepStrictEqual(beforeIds, afterIds)) {
    throw new Error('Railway changed the environment service set outside selected source.checkSuites');
  }

  const selectedById = new Map(selected.map((service) => [service.id, service.name]));
  for (const serviceId of beforeIds) {
    if (!selectedById.has(serviceId)) {
      if (!isDeepStrictEqual(before.services[serviceId], after.services[serviceId])) {
        throw new Error(`Railway changed unselected service ${serviceId}`);
      }
      continue;
    }
    const beforeSelected = cloneJson(before.services[serviceId]);
    const afterSelected = cloneJson(after.services[serviceId]);
    if (!beforeSelected?.source || typeof beforeSelected.source !== 'object'
      || Array.isArray(beforeSelected.source)
      || !afterSelected?.source || typeof afterSelected.source !== 'object'
      || Array.isArray(afterSelected.source)) {
      throw new Error(`Railway changed the selected service source shape for ${selectedById.get(serviceId)}`);
    }
    delete beforeSelected.source.checkSuites;
    delete afterSelected.source.checkSuites;
    if (!isDeepStrictEqual(beforeSelected, afterSelected)) {
      throw new Error(
        `Railway changed fields outside selected source.checkSuites for ${selectedById.get(serviceId)}`,
      );
    }
  }

  const beforeEnvironment = { ...before };
  const afterEnvironment = { ...after };
  delete beforeEnvironment.services;
  delete afterEnvironment.services;
  if (!isDeepStrictEqual(beforeEnvironment, afterEnvironment)) {
    throw new Error('Railway changed environment fields outside selected source.checkSuites');
  }
}

function selectedPending(config, selected, desired) {
  return selected.filter((service) => (
    config?.services?.[service.id]?.source?.checkSuites !== desired
  ));
}

async function waitForReadback(readConfig, before, selected, desired, {
  attempts,
  delayMs,
  sleep,
}) {
  let pending = selected;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const after = readConfig();
    assertReadbackInvariants(before, after, selected);
    pending = selectedPending(after, selected, desired);
    if (pending.length === 0) {
      return after;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(
    `Railway source.checkSuites did not converge for ${pending.map((service) => service.name).join(', ')}`,
  );
}

function defaultRegistry() {
  return JSON.parse(readFileSync(REGISTRY_URL, 'utf8'));
}

export async function executeMigration(argv, {
  railway = runRailway,
  auditConfig = auditRailwayServiceConfig,
  registry = defaultRegistry(),
  env = process.env,
  readbackAttempts = DEFAULT_READBACK_ATTEMPTS,
  readbackDelayMs = DEFAULT_READBACK_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const options = parseMigrationArgs(argv);
  if (options.mode !== 'preview'
    && (environmentMarkerEnabled(env.GITHUB_ACTIONS) || environmentMarkerEnabled(env.CI))) {
    throw new Error('Railway native-autodeploy mutation requires a trusted operator shell; CI and workflows are forbidden');
  }
  const configuredTokens = ['RAILWAY_TOKEN', 'RAILWAY_API_TOKEN']
    .filter((name) => typeof env[name] === 'string' && env[name].length > 0);
  if (configuredTokens.length > 1) {
    throw new Error('provide at most one Railway credential: RAILWAY_TOKEN or RAILWAY_API_TOKEN');
  }
  const childEnv = createRailwayCliEnv({
    ...env,
    RAILWAY_PROJECT_ID: options.projectId,
  });
  const callRailway = (args, callOptions = {}) => {
    try {
      return railway(args, {
        ...callOptions,
        env: childEnv,
      });
    } catch {
      const operation = args.slice(0, args[1]?.startsWith('--') ? 1 : 2).join(' ');
      throw new Error(`Railway ${operation} command failed`);
    }
  };

  const status = parseJsonPayload(callRailway([
    'status',
    '--project', options.projectId,
    '--environment', options.environment,
    '--json',
  ]), 'Railway status');
  const target = resolveRailwayTarget(status, options.projectId, options.environment);

  const serviceList = parseJsonPayload(callRailway([
    'service', 'list',
    '--project', options.projectId,
    '--environment', target.environmentId,
    '--json',
  ]), 'Railway service list');
  const readConfig = () => parseJsonPayload(callRailway([
    'environment', 'config',
    '--environment', target.environmentId,
    '--json',
  ]), 'Railway environment config');
  const before = readConfig();

  const serviceIdsByName = new Map(
    Array.isArray(serviceList)
      ? serviceList.flatMap((service) => (
        typeof service?.name === 'string' && typeof service?.id === 'string'
          ? [[service.name, service.id]]
          : []
      ))
      : [],
  );
  const drift = auditConfig(before, serviceIdsByName, registry);
  if (!Array.isArray(drift)) {
    throw new Error('Railway operational-config audit returned an invalid result');
  }
  if (drift.length > 0) {
    const affected = [...new Set(drift.map((entry) => (
      entry?.service ?? entry?.serviceId ?? 'unknown service'
    )))];
    throw new Error(`Railway operational-config audit is nonzero for ${affected.join(', ')}`);
  }

  const fleet = inspectFleet(serviceList, before);
  const selected = selectServices(fleet, options.services);
  const summary = {
    mode: options.mode,
    projectId: options.projectId,
    environment: options.environment,
    environmentId: target.environmentId,
    repository: REPOSITORY,
    inventory: fleetSummary(fleet.repositoryServices),
    selected: [],
    mutated: false,
  };

  if (options.mode === 'preview') {
    summary.selected = selected.map((service) => ({
      name: service.name,
      id: service.id,
      before: service.checkSuites,
      // A named preview is the dry run for the next native-autodeploy apply.
      // Whole-cohort preview has no selection and remains inventory-only.
      after: false,
    }));
    return summary;
  }

  const desired = options.mode !== 'apply';
  for (const service of selected) {
    if (options.mode === 'apply' && service.checkSuites === false) {
      throw new Error(`${service.name} is already source.checkSuites=false and is not eligible for apply`);
    }
    if (options.mode === 'rollback' && service.checkSuites !== false) {
      throw new Error(`${service.name} must be source.checkSuites=false before rollback`);
    }
  }

  // Freeze the exact environment configuration immediately before the edit.
  // This narrows the race window without adding another controller or lease.
  const precommit = readConfig();
  if (!isDeepStrictEqual(before, precommit)) {
    throw new Error('Railway environment config changed during mutation preflight; retry from a fresh preview');
  }

  let editReportedFailure = false;
  try {
    callRailway([
      'environment', 'edit',
      '--project', options.projectId,
      '--environment', target.environmentId,
      '--message',
      options.mode === 'apply'
        ? 'ops: migrate selected services to native Railway autodeploy'
        : 'ops: roll back selected Railway check-suite gating',
      '--json',
    ], {
      input: serializePatch(selected, desired),
    });
  } catch {
    // A transport or CLI error can occur after Railway commits the patch.
    // The same bounded exact readback below determines the observable outcome.
    editReportedFailure = true;
  }

  try {
    await waitForReadback(readConfig, before, selected, desired, {
      attempts: readbackAttempts,
      delayMs: readbackDelayMs,
      sleep,
    });
  } catch (error) {
    if (editReportedFailure) {
      throw new Error('Railway environment edit: ambiguous edit outcome; run preview before retrying');
    }
    throw error;
  }
  summary.selected = selected.map((service) => ({
    name: service.name,
    id: service.id,
    before: service.checkSuites,
    after: desired,
  }));
  summary.mutated = true;
  return summary;
}

function printHumanSummary(summary) {
  const counts = summary.inventory.checkSuites;
  console.log(
    `Railway native-autodeploy ${summary.mode}: project=${summary.projectId} environment=${summary.environment}`,
  );
  console.log(
    `Repository cohort: ${summary.inventory.repositoryServices} service(s); checkSuites true=${counts.true} false=${counts.false} missing=${counts.missing}`,
  );
  if (summary.selected.length === 0) {
    console.log('Selected services: none (inventory preview only)');
    return;
  }
  for (const service of summary.selected) {
    console.log(`- ${service.name}: ${String(service.before)} -> ${String(service.after)}`);
  }
  console.log(summary.mutated ? 'Mutation applied and exact readback verified.' : 'Preview only; Railway was not edited.');
}

async function main() {
  const summary = await executeMigration(process.argv.slice(2));
  if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
  else printHumanSummary(summary);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
