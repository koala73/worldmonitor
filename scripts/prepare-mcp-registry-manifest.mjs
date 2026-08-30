#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The published description carries the tool count, and the official registry
// rejects a changed payload for an already-published version. server-card.json
// ::tools is held in lockstep with the code registry, so every added tool moves
// that count on its own — 68, 69, 71 and 72 tools all shipped under 1.17.0
// while the registry still advertised 1.13.0/39 (#7372). Pinning the count per
// version makes the tool-addition PR fail here, with the version bump named,
// instead of the post-merge publish job failing closed against the registry.
export function assertPinnedToolInventory(serverCard, ledger) {
  const publishedVersions = ledger?.versions;
  if (!publishedVersions || typeof publishedVersions !== 'object') {
    throw new Error('published-version ledger must expose a `versions` map');
  }
  if (!Array.isArray(serverCard.tools)) {
    throw new Error('server card must contain a tools array to pin');
  }
  const version = serverCard.version;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('server card must declare a version');
  }
  const pinned = publishedVersions[version];
  if (pinned === undefined) {
    throw new Error(
      `server card version ${version} is not pinned in scripts/mcp-registry-published-versions.json; `
        + `add "${version}": ${serverCard.tools.length} so the published tool inventory is reviewed`,
    );
  }
  if (pinned !== serverCard.tools.length) {
    throw new Error(
      `server card declares ${serverCard.tools.length} tools but SERVER_VERSION ${version} is pinned to ${pinned}. `
        + 'The registry refuses a changed payload for an existing version — bump SERVER_VERSION '
        + '(api/mcp/constants.ts), public/.well-known/mcp/server-card.json::serverInfo.version and server.json, '
        + 'then add the new version to scripts/mcp-registry-published-versions.json.',
    );
  }
}

export function buildMcpRegistryManifest(server, serverCard, publishedVersions) {
  if (!Array.isArray(serverCard.tools) || serverCard.tools.length === 0) {
    throw new Error('server card must contain a non-empty tools array');
  }
  if (typeof server.description !== 'string' || server.description.trim() === '') {
    throw new Error('server.json must contain a description');
  }
  if (/\b\d+ tools\b/i.test(server.description)) {
    throw new Error('server.json description must not contain a hand-authored tool count');
  }
  assertPinnedToolInventory(serverCard, publishedVersions);

  const description = `${server.description.trim()} ${serverCard.tools.length} tools.`;
  if (description.length > 100) {
    throw new Error(`published description exceeds 100 characters: ${description.length}`);
  }

  return { ...server, description };
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
  const publishedVersions = JSON.parse(readFileSync(publishedVersionsPath, 'utf-8'));
  const manifest = buildMcpRegistryManifest(server, serverCard, publishedVersions);
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
