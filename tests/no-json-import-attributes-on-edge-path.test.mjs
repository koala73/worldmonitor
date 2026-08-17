/**
 * `with { type: 'json' }` must not appear in the Vercel handler bundle graph.
 *
 * shared/ticker-extract.js:20-30 records the burn: the two JSON-import forms
 * are mutually incompatible across the runtimes shared/ modules reach —
 * `with { type: 'json' }` breaks the Vercel bundle, and a bare JSON import
 * throws ERR_IMPORT_ATTRIBUTE_MISSING under Node 22+. The safe shapes are a
 * bare JSON import from the consuming .ts (what list-feed-digest.ts already
 * does for stocks.json and diplomacy-keywords.json) or an inline literal.
 *
 * That knowledge was a comment, and a comment does not fail CI. #6428 added a
 * shared module using the attribute form and wired it into
 * server/worldmonitor/news/v1/list-feed-digest.ts — a change that typechecks,
 * passes every local esbuild and vite build, and would only break at deploy.
 * This test walks the real import graph from each api/ entrypoint so the next
 * one fails here instead.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const JSON_ATTRIBUTE = /\bfrom\s+['"][^'"]+\.json['"]\s*(?:with|assert)\s*\{\s*type\s*:\s*['"]json['"]\s*\}/;
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^\n;]*?\bfrom\s+['"](\.[^'"]+)['"]/g;
const RESOLVE_EXTS = ['', '.ts', '.js', '.mjs', '.cjs', '.tsx'];

function resolveSpecifier(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  for (const ext of RESOLVE_EXTS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  // A `.js` specifier commonly resolves to a `.ts` source in this repo.
  const swapped = base.replace(/\.js$/, '.ts');
  if (swapped !== base && existsSync(swapped)) return swapped;
  return null;
}

/** Every file reachable from `entry` through relative imports. */
function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (extname(file) === '.json') continue;
    let src;
    try {
      src = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const match of src.matchAll(RELATIVE_IMPORT)) {
      const next = resolveSpecifier(file, match[1]);
      if (next) queue.push(next);
    }
  }
  return seen;
}

function apiEntrypoints(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...apiEntrypoints(full));
    } else if (/\.(ts|mjs|js)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('Vercel handler bundle graph rejects JSON import attributes', () => {
  const entries = apiEntrypoints(resolve(ROOT, 'api'));

  it('found handler entrypoints to walk (guards a vacuous pass)', () => {
    assert.ok(entries.length > 20, `expected many api/ entrypoints, got ${entries.length}`);
  });

  it('reaches deep into shared/ from at least one handler (guards the walker)', () => {
    // If the resolver silently returned null for every specifier, the closures
    // below would be single-file and the assertion after them vacuous.
    const digestConsumers = entries.filter((entry) =>
      [...importClosure(entry)].some((f) => f.endsWith('shared/publisher-families.js')),
    );
    assert.ok(
      digestConsumers.length > 0,
      'no api/ entrypoint reaches shared/publisher-families.js — the import walker is broken, ' +
        'or the module was disconnected from the handler graph',
    );
  });

  it('reaches the source-origin classifier from the MCP handler', () => {
    const originConsumers = entries.filter((entry) =>
      [...importClosure(entry)].some((f) => f.endsWith('scripts/source-origin.mjs')),
    );
    assert.ok(
      originConsumers.some((entry) => entry.endsWith('api/mcp.ts')),
      'api/mcp.ts must bundle the same source-origin classifier used by the public catalog',
    );
  });

  it('no module in any handler closure uses `with { type: \'json\' }`', () => {
    const offenders = new Set();
    for (const entry of entries) {
      for (const file of importClosure(entry)) {
        if (extname(file) === '.json') continue;
        let src;
        try {
          src = readFileSync(file, 'utf-8');
        } catch {
          continue;
        }
        if (JSON_ATTRIBUTE.test(src)) {
          offenders.add(`${relative(ROOT, file)} (reached from ${relative(ROOT, entry)})`);
        }
      }
    }
    assert.deepEqual(
      [...offenders].sort(),
      [],
      'These modules are bundled into a Vercel handler and use the JSON import-attribute form, ' +
        'which breaks that bundler (shared/ticker-extract.js:20-30). Inline the data as a literal, ' +
        'or bare-import the JSON from the consuming .ts and pass it in:\n  ' +
        [...offenders].join('\n  '),
    );
  });
});
