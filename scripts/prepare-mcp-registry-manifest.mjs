#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildMcpRegistryManifest(server, serverCard) {
  if (!Array.isArray(serverCard.tools) || serverCard.tools.length === 0) {
    throw new Error('server card must contain a non-empty tools array');
  }
  if (typeof server.description !== 'string' || server.description.trim() === '') {
    throw new Error('server.json must contain a description');
  }
  if (/\b\d+ tools\b/i.test(server.description)) {
    throw new Error('server.json description must not contain a hand-authored tool count');
  }

  const description = `${server.description.trim()} ${serverCard.tools.length} tools.`;
  if (description.length > 100) {
    throw new Error(`published description exceeds 100 characters: ${description.length}`);
  }

  return { ...server, description };
}

export function prepareMcpRegistryManifest({
  serverPath = resolve(ROOT, 'server.json'),
  serverCardPath = resolve(ROOT, 'public/.well-known/mcp/server-card.json'),
  outputPath,
} = {}) {
  if (!outputPath) throw new Error('outputPath is required');

  const server = JSON.parse(readFileSync(serverPath, 'utf-8'));
  const serverCard = JSON.parse(readFileSync(serverCardPath, 'utf-8'));
  const manifest = buildMcpRegistryManifest(server, serverCard);
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
