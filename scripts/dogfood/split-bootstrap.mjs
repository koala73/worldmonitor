#!/usr/bin/env node
// Trusted setup for the panel content run: fetch the dashboard's shared startup data once and save each top-level
// key as its own file, so the agent can compare a panel with its API data by reading a few kilobytes.
//
// Most panels are filled from /api/bootstrap (tier=fast and tier=slow, the same for every monitor). Those bodies
// are about 0.5 MB and 1.4 MB, too large for the agent to read: in a pilot it skipped the comparison rather than
// open them, and missed a panel that contradicted its own API. Reading `fast-theaterPosture.json` (1.3 KB) instead
// costs almost nothing.
//
// Usage: node split-bootstrap.mjs <api origin> <page origin> <output dir>   (prints one "name size" line per file written)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../lib/main-module.mjs';

const KEY = /^[A-Za-z0-9_-]+$/;

/** JSON with the top two levels indented and anything deeper on one line: one record (a quote, a theater) per line. */
export function layout(value, depth = 0) {
  if (depth >= 2 || value === null || typeof value !== 'object') return JSON.stringify(value);
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  const entries = Array.isArray(value)
    ? value.map((item) => `${pad}${layout(item, depth + 1)}`)
    : Object.entries(value).map(([key, item]) => `${pad}${JSON.stringify(key)}: ${layout(item, depth + 1)}`);
  if (entries.length === 0) return Array.isArray(value) ? '[]' : '{}';
  return Array.isArray(value) ? `[\n${entries.join(',\n')}\n${close}]` : `{\n${entries.join(',\n')}\n${close}}`;
}

/** One file per tier and top-level key (see `layout`), smallest first so the index reads as a guide to cheap reads. */
export function splitBootstrap(payloads) {
  const files = [];
  for (const [tier, payload] of Object.entries(payloads)) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : payload;
    for (const [key, value] of Object.entries(data)) {
      if (!KEY.test(key)) continue;
      files.push({ name: `${tier}-${key}.json`, text: `${layout(value)}\n` });
    }
  }
  return files.sort((a, b) => a.text.length - b.text.length);
}

async function fetchTier(origin, pageOrigin, tier) {
  try {
    const response = await fetch(`${origin}/api/bootstrap?tier=${tier}&public=1`, {
      headers: { 'User-Agent': 'worldmonitor-dogfood/1.0 (panel content review)', Origin: pageOrigin },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) { console.error(`bootstrap ${tier}: HTTP ${response.status}`); return null; }
    return await response.json();
  } catch (error) {
    console.error(`bootstrap ${tier}: ${error.message}`);
    return null;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const [origin, pageOrigin, outDir] = process.argv.slice(2);
  const files = splitBootstrap({ fast: await fetchTier(origin, pageOrigin, 'fast'), slow: await fetchTier(origin, pageOrigin, 'slow') });
  mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    writeFileSync(join(outDir, file.name), file.text);
    console.log(`${file.name} ${file.text.length}`);
  }
}
