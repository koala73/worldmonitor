import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_REGISTRY } from '../api/mcp.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function listTrackedSeedScripts() {
  return execFileSync('git', ['ls-files', 'scripts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .filter((file) => /^scripts\/seed-.*\.mjs$/.test(file));
}

function readCanonicalKey(file) {
  const src = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const match = src.match(/(?:export\s+)?const\s+CANONICAL_KEY\s*=\s*'([^']+)'/);
  return match?.[1] ?? null;
}

describe('MCP seed coverage', () => {
  it('references every tracked seed script canonical key from the MCP cache tool registry', () => {
    const cacheKeys = new Set(
      TOOL_REGISTRY
        .filter((tool) => Array.isArray(tool._cacheKeys))
        .flatMap((tool) => tool._cacheKeys),
    );

    const missing = [];
    for (const file of listTrackedSeedScripts()) {
      const canonicalKey = readCanonicalKey(file);
      if (canonicalKey && !cacheKeys.has(canonicalKey)) {
        missing.push({ file, canonicalKey });
      }
    }

    assert.deepEqual(
      missing,
      [],
      `Tracked seed scripts missing MCP exposure:\n${missing.map(({ file, canonicalKey }) => `${file} -> ${canonicalKey}`).join('\n')}`,
    );
  });
});
