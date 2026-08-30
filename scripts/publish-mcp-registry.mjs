#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MCP_REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';
export const MCP_REGISTRY_USER_AGENT =
  'WorldMonitor-MCP-Registry-Publish/1.0 (+https://worldmonitor.app)';
export const MCP_REGISTRY_LOOKUP_TIMEOUT_MS = 15_000;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function canonicalizeMcpRegistryJson(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalizeMcpRegistryJson(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalizeMcpRegistryJson(value[key]);
  }
  return out;
}

export function stableMcpRegistryStringify(value) {
  return JSON.stringify(canonicalizeMcpRegistryJson(value));
}

export function extractPublishedServer(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('registry payload must be an object');
  }
  if (payload.server && typeof payload.server === 'object' && !Array.isArray(payload.server)) {
    return payload.server;
  }
  if (typeof payload.name === 'string' && typeof payload.version === 'string') {
    return payload;
  }
  throw new Error('registry payload is missing a server object');
}

export function extractPublishedStatus(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const official = payload._meta?.['io.modelcontextprotocol.registry/official'];
  return typeof official?.status === 'string' ? official.status : null;
}

export function loadDesiredMcpRegistryManifest(manifestPath) {
  requireNonEmptyString(manifestPath, 'manifestPath');
  const desired = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (!desired || typeof desired !== 'object' || Array.isArray(desired)) {
    throw new Error('desired manifest must be a JSON object');
  }
  requireNonEmptyString(desired.name, 'desired manifest name');
  requireNonEmptyString(desired.version, 'desired manifest version');
  return desired;
}

export function registryVersionUrl(
  name,
  version,
  baseUrl = MCP_REGISTRY_BASE_URL,
) {
  const serverName = requireNonEmptyString(name, 'name');
  const serverVersion = requireNonEmptyString(version, 'version');
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new Error('baseUrl must be an http(s) URL');
  }
  return `${baseUrl.replace(/\/$/, '')}/v0.1/servers/${encodeURIComponent(serverName)}/versions/${encodeURIComponent(serverVersion)}`;
}

export function describeManifestDiff(desired, published) {
  const left = canonicalizeMcpRegistryJson(desired);
  const right = canonicalizeMcpRegistryJson(published);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.filter((key) => stableMcpRegistryStringify(left[key]) !== stableMcpRegistryStringify(right[key]));
}

export function manifestsAreEquivalent(desired, published) {
  if (!desired || typeof desired !== 'object' || Array.isArray(desired)) {
    throw new Error('desired manifest must be an object');
  }
  if (!published || typeof published !== 'object' || Array.isArray(published)) {
    throw new Error('published manifest must be an object');
  }
  return stableMcpRegistryStringify(desired) === stableMcpRegistryStringify(published);
}

export function isDuplicateVersionPublishError(text) {
  if (typeof text !== 'string') return false;
  return /invalid[-\s]version/i.test(text) || /cannot publish duplicate version/i.test(text);
}

export async function fetchPublishedMcpRegistryVersion({
  name,
  version,
  baseUrl = MCP_REGISTRY_BASE_URL,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = MCP_REGISTRY_LOOKUP_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive integer');
  }

  const url = registryVersionUrl(name, version, baseUrl);
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': MCP_REGISTRY_USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 404) return { found: false, url };
  if (!response.ok) {
    const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 500) : '';
    const error = new Error(`registry lookup failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
    error.code = 'registry_lookup_failed';
    error.status = response.status;
    throw error;
  }

  const payload = await response.json();
  const server = extractPublishedServer(payload);
  return {
    found: true,
    url,
    payload,
    server,
    status: extractPublishedStatus(payload),
  };
}

function failClosedOnExisting(desired, published, { status = null } = {}) {
  if (status && status !== 'active') {
    throw new Error(
      `MCP registry already has ${desired.name}@${desired.version} with status ${status}; refusing to treat a non-active record as success`,
    );
  }
  if (manifestsAreEquivalent(desired, published)) {
    return { action: 'skip', reason: 'equivalent-existing-version' };
  }
  const changed = describeManifestDiff(desired, published);
  throw new Error(
    `MCP registry already has ${desired.name}@${desired.version} but the payload differs (${changed.join(', ') || 'unknown fields'}). Fail closed — bump the server version to publish a replacement.`,
  );
}

export function decideMcpRegistryPublishAction(desired, lookup) {
  if (!desired || typeof desired !== 'object' || Array.isArray(desired)) {
    throw new Error('desired manifest must be an object');
  }
  requireNonEmptyString(desired.name, 'desired manifest name');
  requireNonEmptyString(desired.version, 'desired manifest version');
  if (!lookup || typeof lookup !== 'object') {
    throw new Error('lookup result must be an object');
  }
  if (lookup.found === false) return { action: 'publish', reason: 'version-absent' };
  if (lookup.found !== true || !lookup.server) {
    throw new Error('lookup result must be { found: false } or { found: true, server }');
  }
  return failClosedOnExisting(desired, lookup.server, { status: lookup.status });
}

export function runMcpPublisher(commandAndArgs, {
  spawnSyncImpl = spawnSync,
  cwd = process.cwd(),
  stdio = ['ignore', 'pipe', 'pipe'],
} = {}) {
  if (!Array.isArray(commandAndArgs) || commandAndArgs.length === 0) {
    throw new Error('publish command is required');
  }
  const [command, ...args] = commandAndArgs;
  requireNonEmptyString(command, 'publish command');
  if (typeof spawnSyncImpl !== 'function') throw new Error('spawnSyncImpl must be a function');

  const result = spawnSyncImpl(command, args, { cwd, encoding: 'utf8', stdio });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ?? null,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`,
  };
}

export async function publishMcpRegistryIdempotent({
  manifestPath,
  publishCommand,
  fetchImpl = (...args) => globalThis.fetch(...args),
  spawnSyncImpl = spawnSync,
  cwd = process.cwd(),
  baseUrl = MCP_REGISTRY_BASE_URL,
  timeoutMs = MCP_REGISTRY_LOOKUP_TIMEOUT_MS,
} = {}) {
  const desired = loadDesiredMcpRegistryManifest(manifestPath);
  const command = Array.isArray(publishCommand) && publishCommand.length > 0
    ? publishCommand
    : ['./mcp-publisher', 'publish', manifestPath];

  let lookup;
  try {
    lookup = await fetchPublishedMcpRegistryVersion({
      name: desired.name,
      version: desired.version,
      baseUrl,
      fetchImpl,
      timeoutMs,
    });
  } catch (error) {
    const lookupFailed = error?.code === 'registry_lookup_failed'
      || error?.name === 'TimeoutError'
      || error?.name === 'AbortError'
      || (error instanceof TypeError && /fetch/i.test(error.message ?? ''));
    if (!lookupFailed) throw error;
    lookup = { found: false, lookupFailed: true, error };
  }

  if (!lookup.lookupFailed) {
    const decision = decideMcpRegistryPublishAction(desired, lookup);
    if (decision.action === 'skip') {
      return {
        outcome: 'already-published',
        name: desired.name,
        version: desired.version,
      };
    }
  }

  const published = runMcpPublisher(command, { spawnSyncImpl, cwd });
  if (published.status === 0) {
    return {
      outcome: lookup.lookupFailed ? 'published-after-lookup-failure' : 'published',
      name: desired.name,
      version: desired.version,
    };
  }

  const combined = `${published.output}\n${published.error?.message ?? ''}`;
  if (!isDuplicateVersionPublishError(combined)) {
    throw new Error(
      `mcp-publisher publish failed (${published.status ?? published.signal ?? 'unknown'}): ${combined.trim() || 'no output'}`,
    );
  }

  const existing = await fetchPublishedMcpRegistryVersion({
    name: desired.name,
    version: desired.version,
    baseUrl,
    fetchImpl,
    timeoutMs,
  });
  if (existing.found !== true) {
    throw new Error(
      `mcp-publisher reported an invalid-version error for ${desired.name}@${desired.version}, but the registry does not currently return that version. Fail closed.`,
    );
  }
  failClosedOnExisting(desired, existing.server, { status: existing.status });
  return {
    outcome: 'already-published-after-conflict',
    name: desired.name,
    version: desired.version,
  };
}

export function parsePublishMcpRegistryCli(argv) {
  if (!Array.isArray(argv)) throw new Error('argv must be an array');
  const dash = argv.indexOf('--');
  const before = dash === -1 ? argv.slice(2) : argv.slice(2, dash);
  const after = dash === -1 ? [] : argv.slice(dash + 1);
  if (before.length > 1) {
    throw new Error('usage: publish-mcp-registry.mjs [manifest] [-- publisher-command...]');
  }
  const manifestPath = resolve(ROOT, before[0] ?? 'registry-server.json');
  const publishCommand = after.length > 0 ? after : ['./mcp-publisher', 'publish', manifestPath];
  return { manifestPath, publishCommand };
}

async function main(argv = process.argv) {
  const startedAt = Date.now();
  const { manifestPath, publishCommand } = parsePublishMcpRegistryCli(argv);
  const result = await publishMcpRegistryIdempotent({
    manifestPath,
    publishCommand,
    cwd: process.cwd(),
  });
  if (result.outcome === 'already-published' || result.outcome === 'already-published-after-conflict') {
    console.log(`MCP registry already has equivalent ${result.name}@${result.version}; treating as success`);
  } else {
    console.log(`Published ${result.name}@${result.version} (${result.outcome})`);
  }
  console.log(`=== Done (${Date.now() - startedAt}ms) ===`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`MCP registry publish failed: ${error.message}`);
    process.exit(1);
  });
}
