#!/usr/bin/env node
// Keep build-only attribution evidence out of the MCP Edge bundle.
import { readFileSync, writeFileSync } from 'node:fs';

const source = new URL('../shared/source-attribution-manifest.json', import.meta.url);
const output = new URL('../api/mcp/registry/_source-providers.generated.json', import.meta.url);
const fields = ['host', 'provider', 'kind', 'status', 'license'];
const { entries } = JSON.parse(readFileSync(source, 'utf8'));
// MCP exposes only active provider rows and the excluded population's count.
// Do this projection at build time rather than shipping discarded records to Edge.
const active = entries.filter((entry) => entry.observed === true
  && entry.catalogActive !== false
  && (entry.status === 'reviewed' || entry.status === 'terms-review'));
const providers = active.map((entry) => Object.fromEntries(
  fields.filter((field) => Object.hasOwn(entry, field)).map((field) => [field, entry[field]]),
));
const excludedProviderCount = entries.filter((entry) => entry.status === 'excluded').length;
const expected = `${JSON.stringify({ providers, excludedProviderCount })}\n`;
if (process.argv.includes('--check')) {
  let actual;
  try { actual = readFileSync(output, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (actual !== expected) {
    console.error('MCP source providers are stale; run npm run generate');
    process.exitCode = 1;
  }
} else {
  writeFileSync(output, expected);
}
