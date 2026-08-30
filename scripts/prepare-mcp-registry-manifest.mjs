#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stableMcpRegistryStringify } from './publish-mcp-registry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The official registry refuses to republish a version whose payload changed —
// publish-mcp-registry.mjs compares the WHOLE canonicalized manifest and fails
// closed on any differing key. Nothing forces the version to move with it:
// server-card.json::tools tracks the code registry, so 68, 69, 71 and 72 tools
// all shipped under SERVER_VERSION 1.17.0 while the published description sat
// frozen at 39 (#7372), and a plain copy edit to server.json::description does
// the same with even less of a version-bump smell. So each version pins the
// exact payload it publishes: the tool count for a legible message, and a
// fingerprint over the derived manifest for everything else. The drift then
// fails on the PR that causes it, naming the bump, instead of reding the
// post-merge publish job every day until someone reads the logs.
export function mcpRegistryManifestFingerprint(manifest) {
  return createHash('sha256').update(stableMcpRegistryStringify(manifest)).digest('hex');
}

function pinnedEntry(version, ledger) {
  const publishedVersions = ledger?.versions;
  if (!publishedVersions || typeof publishedVersions !== 'object') {
    throw new Error('published-version ledger must expose a `versions` map');
  }
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('a non-empty version is required to look up its pin');
  }
  if (!Object.hasOwn(publishedVersions, version)) return null;
  const pinned = publishedVersions[version];
  if (!pinned || typeof pinned !== 'object') {
    throw new Error(`ledger entry for ${version} must be an object with tools and manifestSha256`);
  }
  return pinned;
}

const BUMP_INSTRUCTIONS = 'bump SERVER_VERSION (api/mcp/constants.ts) plus the matching '
  + '`version` and `serverInfo.version` in public/.well-known/mcp/server-card.json and '
  + 'server.json, then add the new version to scripts/mcp-registry-published-versions.json';

export function assertPinnedToolInventory(serverCard, ledger) {
  if (!serverCard || !Array.isArray(serverCard.tools)) {
    throw new Error('server card must contain a tools array to pin');
  }
  const version = serverCard.version;
  const pinned = pinnedEntry(version, ledger);
  if (pinned === null) {
    throw new Error(
      `server card version ${version} is not pinned in scripts/mcp-registry-published-versions.json; `
        + `add an entry with "tools": ${serverCard.tools.length} so the published inventory is reviewed`,
    );
  }
  if (pinned.tools !== serverCard.tools.length) {
    throw new Error(
      `server card declares ${serverCard.tools.length} tools but version ${version} is pinned to ${pinned.tools}. `
        + `The registry refuses a changed payload for an existing version — ${BUMP_INSTRUCTIONS}.`,
    );
  }
}

export function assertPinnedManifestPayload(manifest, ledger) {
  const pinned = pinnedEntry(manifest?.version, ledger);
  if (pinned === null) {
    throw new Error(`manifest version ${manifest?.version} is not pinned in the published-version ledger`);
  }
  const fingerprint = mcpRegistryManifestFingerprint(manifest);
  if (pinned.manifestSha256 !== fingerprint) {
    throw new Error(
      `the published payload for version ${manifest.version} changed (pinned ${pinned.manifestSha256}, built ${fingerprint}). `
        + `The registry refuses a changed payload for an existing version — ${BUMP_INSTRUCTIONS}. `
        + `For a new version, pin "manifestSha256": "${fingerprint}".`,
    );
  }
}

export function buildMcpRegistryManifest(server, serverCard, ledger) {
  if (!Array.isArray(serverCard.tools) || serverCard.tools.length === 0) {
    throw new Error('server card must contain a non-empty tools array');
  }
  if (typeof server.description !== 'string' || server.description.trim() === '') {
    throw new Error('server.json must contain a description');
  }
  if (/\b\d+ tools\b/i.test(server.description)) {
    throw new Error('server.json description must not contain a hand-authored tool count');
  }
  // The pin is keyed on the server card, but the manifest publishes
  // server.json's version. Left unchecked, a card at 1.17.0 and a server.json
  // at 1.16.0 would publish 1.16.0 carrying a 1.17.0 inventory.
  if (server.version !== serverCard.version) {
    throw new Error(
      `server.json version ${server.version} does not match server card version ${serverCard.version}; `
        + 'the published version and the pinned inventory must be the same version',
    );
  }
  assertPinnedToolInventory(serverCard, ledger);

  const description = `${server.description.trim()} ${serverCard.tools.length} tools.`;
  if (description.length > 100) {
    throw new Error(`published description exceeds 100 characters: ${description.length}`);
  }

  const manifest = { ...server, description };
  assertPinnedManifestPayload(manifest, ledger);
  return manifest;
}

export function prepareMcpRegistryManifest({
  serverPath = resolve(ROOT, 'server.json'),
  serverCardPath = resolve(ROOT, 'public/.well-known/mcp/server-card.json'),
  publishedVersionsPath = resolve(ROOT, 'scripts/mcp-registry-published-versions.json'),
  outputPath,
} = {}) {
  if (!outputPath) throw new Error('outputPath is required');

  const server = JSON.parse(readFileSync(serverPath, 'utf-8'));
  const serverCard = JSON.parse(readFileSync(serverCardPath, 'utf-8'));
  const ledger = JSON.parse(readFileSync(publishedVersionsPath, 'utf-8'));
  const manifest = buildMcpRegistryManifest(server, serverCard, ledger);
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outputPath = resolve(ROOT, process.argv[2] ?? 'registry-server.json');
    const manifest = prepareMcpRegistryManifest({ outputPath });
    console.log(`Prepared ${outputPath} with ${manifest.description}`);
  } catch (error) {
    console.error(`MCP registry manifest preparation failed: ${error.message}`);
    process.exit(1);
  }
}
