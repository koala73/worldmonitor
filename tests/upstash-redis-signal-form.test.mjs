// @upstash/redis handles the two `signal` forms differently on abort:
// a FUNCTION signal rethrows, but a STATIC AbortSignal resolves a synthetic
// 200 `{ result: 'Aborted' }`. Behind a rate limiter that reads as an allow, so
// a static deadline would fail open without any error. Pin the function form.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(rel);
    return /\.(?:[cm]?js|ts)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [rel] : [];
  });
}

/** The argument text of each `new Redis({...})`, matched by brace depth. */
function redisConstructorArgs(src) {
  const args = [];
  for (let at = src.indexOf('new Redis({'); at !== -1; at = src.indexOf('new Redis({', at + 1)) {
    const start = at + 'new Redis('.length;
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { args.push(src.slice(start, i + 1)); break; }
    }
  }
  return args;
}

describe('Upstash Redis clients', () => {
  const clients = ['api', 'server'].flatMap(sourceFiles).flatMap((file) => {
    const src = readFileSync(join(root, file), 'utf8');
    return redisConstructorArgs(src).map((arg) => ({ file, arg }));
  });

  it('finds the limiter clients this guard protects', () => {
    assert.ok(clients.length >= 10, `expected the rate-limit Redis clients, found ${clients.length}`);
  });

  it('pass a deadline only as a signal factory, never a static AbortSignal', () => {
    for (const { file, arg } of clients) {
      if (!/\bsignal\s*:/.test(arg)) continue;
      assert.match(arg, /\bsignal\s*:\s*\(\)\s*=>/, `${file}: a static Redis signal resolves aborted calls as success`);
    }
  });
});
