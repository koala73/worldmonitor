import { performance } from 'node:perf_hooks';

import {
  DEFAULT_CONCURRENCY,
  RAILWAY_CALL_TIMEOUT_MS,
  REPOSITORY,
  isRepositoryService,
  mapWithConcurrency,
  resolveEnvironmentId,
  runRailwayApiAsync,
} from './railway-cli.mjs';
import { isValidDeploymentTimestamp } from './railway-deployments.mjs';

export const DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR = 'run deadline reached before deployment configuration read';

// Viewer-safe by construction: the query names only service source, build,
// deploy and Git deployment-trigger fields. It has no environment-variable
// field, so a future output formatter cannot accidentally expose one.
export const DEPLOYMENT_ONLY_QUERY = `query ViewerDeploymentConfig(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
  $includeActiveDeployments: Boolean!
) {
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    serviceId
    source { repo image }
    activeDeployments @include(if: $includeActiveDeployments) {
      id status createdAt serviceId meta
    }
    rootDirectory
    watchPatterns
    dockerfilePath
    startCommand
    cronSchedule
  }
  deploymentTriggers(
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $serviceId
    first: 2
  ) {
    pageInfo { hasNextPage }
    edges {
      node { serviceId repository branch checkSuites provider }
    }
  }
}`;

function triggerNodes(connection) {
  if (!connection || !Array.isArray(connection.edges)) {
    throw new Error('Railway deploymentTriggers must contain an edges array');
  }
  if (typeof connection.pageInfo?.hasNextPage !== 'boolean') {
    throw new Error('Railway deploymentTriggers must report whether another page exists');
  }
  if (connection.pageInfo.hasNextPage === true) {
    throw new Error('Railway deploymentTriggers exceeded the complete Viewer projection page');
  }
  return connection.edges.map((edge, index) => {
    if (!edge?.node || typeof edge.node !== 'object' || Array.isArray(edge.node)) {
      throw new Error(`Railway deploymentTriggers edge ${index} is malformed`);
    }
    return edge.node;
  });
}

function activeDeploymentNodes(instance, service) {
  if (!Array.isArray(instance.activeDeployments)) {
    throw new Error(`Railway active deployments must be an array for ${service.name}`);
  }
  return instance.activeDeployments.map((deployment, index) => {
    if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment)
      || typeof deployment.id !== 'string' || deployment.id.length === 0
      || typeof deployment.status !== 'string' || deployment.status.length === 0
      || !isValidDeploymentTimestamp(deployment.createdAt)) {
      throw new Error(`Railway active deployment ${index} is malformed for ${service.name}`);
    }
    if (deployment.serviceId !== service.id) {
      throw new Error(`Railway active deployment ${deployment.id} belongs to another service while reading ${service.name}`);
    }
    if (deployment.meta != null
      && (typeof deployment.meta !== 'object' || Array.isArray(deployment.meta))) {
      throw new Error(`Railway active deployment ${deployment.id} has malformed metadata for ${service.name}`);
    }
    return deployment;
  });
}

export function projectViewerDeploymentConfig({
  service,
  instance,
  triggers,
  includeActiveDeployments = false,
}) {
  if (!service?.id || !instance || typeof instance !== 'object' || Array.isArray(instance)) {
    throw new Error(`Railway returned no serviceInstance projection for ${service?.name ?? service?.id ?? 'unknown service'}`);
  }
  if (instance.serviceId !== service.id) {
    throw new Error(`Railway serviceInstance id ${instance.serviceId} does not match ${service.id}`);
  }
  const nodes = triggerNodes(triggers);
  if (nodes.some((trigger) => trigger.serviceId !== service.id)) {
    throw new Error(`Railway deploymentTriggers returned another service while reading ${service.name}`);
  }
  if (!isRepositoryService(service) || !isRepositoryService(instance)
    || service.source?.image != null || instance.source?.image != null) {
    throw new Error(`Railway source repository is missing or inconsistent for ${service.name}`);
  }
  if (nodes.length !== 1 || nodes[0].repository !== REPOSITORY) {
    throw new Error(`Railway must return exactly one ${REPOSITORY} deployment trigger for ${service.name}`);
  }
  const trigger = nodes[0];
  if (typeof trigger.branch !== 'string'
    || typeof trigger.checkSuites !== 'boolean'
    || typeof trigger.provider !== 'string') {
    throw new Error(`Railway returned a malformed deployment trigger for ${service.name}`);
  }
  if (trigger.provider !== 'github') {
    throw new Error(`Railway must return a GitHub deployment trigger for ${service.name}`);
  }
  return {
    source: {
      repo: REPOSITORY,
      rootDirectory: instance.rootDirectory ?? null,
      branch: trigger.branch,
      checkSuites: trigger.checkSuites,
    },
    build: {
      watchPatterns: instance.watchPatterns ?? [],
      dockerfilePath: instance.dockerfilePath ?? null,
    },
    deploy: {
      startCommand: instance.startCommand ?? null,
      cronSchedule: instance.cronSchedule ?? null,
    },
    ...(includeActiveDeployments
      ? { activeDeployments: activeDeploymentNodes(instance, service) }
      : {}),
  };
}

export async function readViewerDeploymentConfig(
  environment,
  services,
  {
    projectId = process.env.RAILWAY_PROJECT_ID,
    environmentId = null,
    resolveEnvironment = resolveEnvironmentId,
    api = runRailwayApiAsync,
    concurrency = DEFAULT_CONCURRENCY,
    includeActiveDeployments = false,
    deadlineAt = Number.POSITIVE_INFINITY,
    monotonicNow = () => performance.now(),
  } = {},
) {
  if (!projectId) throw new Error('RAILWAY_PROJECT_ID is required for the Viewer deployment projection');
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error('Railway service inventory was empty');
  }
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error('Viewer deployment projection concurrency must be a positive integer');
  }
  for (const service of services) {
    if (!service?.id || !service?.name) {
      throw new Error('Railway service inventory contains a malformed service');
    }
  }
  let resolvedEnvironmentId = environmentId;
  if (resolvedEnvironmentId === null) {
    const remainingMs = deadlineAt - monotonicNow();
    if (!(remainingMs > 0)) throw new Error(DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR);
    resolvedEnvironmentId = resolveEnvironment(environment, projectId, {
      timeoutMs: Math.min(RAILWAY_CALL_TIMEOUT_MS, Math.max(1, Math.floor(remainingMs))),
    });
    if (!(deadlineAt - monotonicNow() > 0)) {
      throw new Error(DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR);
    }
  }
  const projected = await mapWithConcurrency(services, concurrency, async (service) => {
    const remainingMs = deadlineAt - monotonicNow();
    if (!(remainingMs > 0)) {
      throw new Error(DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR);
    }
    const data = await api(DEPLOYMENT_ONLY_QUERY, {
      projectId,
      environmentId: resolvedEnvironmentId,
      serviceId: service.id,
      includeActiveDeployments,
    }, {
      timeoutMs: Math.min(RAILWAY_CALL_TIMEOUT_MS, Math.max(1, Math.floor(remainingMs))),
    });
    if (!(deadlineAt - monotonicNow() > 0)) {
      throw new Error(DEPLOYMENT_CONFIG_READ_DEADLINE_ERROR);
    }
    return [service.id, projectViewerDeploymentConfig({
      service,
      instance: data?.serviceInstance,
      triggers: data?.deploymentTriggers,
      includeActiveDeployments,
    })];
  });
  return { services: Object.fromEntries(projected) };
}
