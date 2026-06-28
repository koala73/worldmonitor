#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const TARGET_FILE = path.join(ROOT, 'server/_shared/airline-codes.ts');
const SOURCE_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  values.push(current);
  return values;
}

function normalizeField(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '\\N') return null;
  return trimmed;
}

function parseAirlinesDat(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const map = new Map();

  for (const line of lines) {
    const row = parseCsvLine(line);
    if (row.length < 8) continue;

    const name = normalizeField(row[1] ?? '');
    const iata = normalizeField(row[3] ?? '');
    const icao = normalizeField(row[4] ?? '');
    const active = normalizeField(row[7] ?? '');

    if (!name || !iata || !icao) continue;
    if (active !== 'Y') continue;
    if (!/^[A-Z0-9]{2}$/.test(iata)) continue;
    if (!/^[A-Z]{3}$/.test(icao)) continue;

    if (!map.has(icao)) {
      map.set(icao, { iata, name });
    }
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function extractGeneratedEntries(fileText) {
  const match = fileText.match(/const GENERATED = new Map<string, \{ iata: string; name: string \}>\(\[(?<body>[\s\S]*?)\]\);/);
  if (!match?.groups?.body) {
    throw new Error('Could not locate GENERATED block in server/_shared/airline-codes.ts');
  }

  const entries = new Map();
  const entryRegex = /\[(['"])(.*?)\1, \{ iata: (['"])(.*?)\3, name: (['"])(.*?)\5 \}\],/g;
  for (const entryMatch of match.groups.body.matchAll(entryRegex)) {
    const [, , icao, , iata, , name] = entryMatch;
    entries.set(icao, { iata, name });
  }
  return entries;
}

function renderGeneratedBlock(entries) {
  const lines = [...entries.entries()].map(([icao, { iata, name }]) => {
    return `  [${JSON.stringify(icao)}, { iata: ${JSON.stringify(iata)}, name: ${JSON.stringify(name)} }],`;
  });

  return [
    'const GENERATED = new Map<string, { iata: string; name: string }>([',
    ...lines,
    ']);',
  ].join('\n');
}

function diffCounts(previous, next) {
  let added = 0;
  let removed = 0;
  let changed = 0;

  for (const [icao, value] of next.entries()) {
    const prev = previous.get(icao);
    if (!prev) {
      added += 1;
      continue;
    }
    if (prev.iata !== value.iata || prev.name !== value.name) {
      changed += 1;
    }
  }

  for (const icao of previous.keys()) {
    if (!next.has(icao)) removed += 1;
  }

  return { added, removed, changed };
}

async function main() {
  const [sourceResp, fileText] = await Promise.all([
    fetch(SOURCE_URL),
    readFile(TARGET_FILE, 'utf8'),
  ]);

  if (!sourceResp.ok) {
    throw new Error(`Failed to fetch airlines.dat: ${sourceResp.status} ${sourceResp.statusText}`);
  }

  const sourceText = await sourceResp.text();
  const sourceSha256 = createHash('sha256').update(sourceText).digest('hex');
  const previousEntries = extractGeneratedEntries(fileText);
  const nextEntries = parseAirlinesDat(sourceText);
  const nextBlock = renderGeneratedBlock(nextEntries);

  const updatedText = fileText.replace(
    /const GENERATED = new Map<string, \{ iata: string; name: string \}>\(\[[\s\S]*?\]\);/,
    nextBlock,
  );

  const { added, removed, changed } = diffCounts(previousEntries, nextEntries);
  console.log(`Source: ${SOURCE_URL}`);
  console.log(`Source SHA-256: ${sourceSha256}`);

  if (updatedText === fileText) {
    console.log(`No changes. ${nextEntries.size} entries already up to date.`);
    console.log('Added: 0');
    console.log('Removed: 0');
    console.log('Changed: 0');
    return;
  }

  await writeFile(TARGET_FILE, updatedText, 'utf8');

  console.log(`Wrote ${nextEntries.size} entries to ${path.relative(ROOT, TARGET_FILE)}`);
  console.log(`Added: ${added}`);
  console.log(`Removed: ${removed}`);
  console.log(`Changed: ${changed}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
