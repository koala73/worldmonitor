import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const REGISTRY_DIR = join(ROOT, 'api/mcp/registry');
const LLMS_FILES = ['public/llms.txt', 'public/llms-full.txt', 'public/api/llms.txt'];

// Every MCP tool name uses a verb prefix (get_/generate_/analyze_/search_/
// describe_), so this picks tool citations out of the backticked prose
// without also matching auth headers (`X-WorldMonitor-Key`), query params
// (`scope=mcp`), or CSS props (`contain-intrinsic-size`) that are backticked.
const TOOL_TOKEN_RE = /`((?:get|generate|analyze|search|describe)_[a-z0-9_]+)`/g;
// Same `name: '<tool>'` extraction the coverage auditor uses
// (scripts/audit-mcp-api-coverage.mjs), applied across the whole registry
// dir so both rpc-tools.ts and cache-tools.ts are covered.
const REGISTRY_NAME_RE = /\bname:\s*['"]([a-z_][a-z0-9_]*)['"]/g;

function registryToolNames() {
  const names = new Set();
  for (const f of readdirSync(REGISTRY_DIR)) {
    if (!f.endsWith('.ts')) continue;
    const src = readFileSync(join(REGISTRY_DIR, f), 'utf-8');
    for (const m of src.matchAll(REGISTRY_NAME_RE)) names.add(m[1]);
  }
  return names;
}

function citedTools(text) {
  return [...new Set([...text.matchAll(TOOL_TOKEN_RE)].map((m) => m[1]))].sort();
}

// Guards the "When to Use World Monitor (Agent Guidance)" section of the
// public agent files (orank Identity when-to-use gap, PR #4690). llms.txt is
// hand-maintained and no other test reads its content — docs-stats only checks
// numeric layer claims in llms-full.txt, and lint:md globs `**/*.md` (skips
// .txt). Without this guard, renaming or removing an MCP tool would silently
// leave the agent guidance pointing at a tool that no longer exists.
describe('agent readiness: llms.txt MCP tool citations', () => {
  const registry = registryToolNames();

  it('the MCP registry exposes a non-trivial tool set', () => {
    assert.ok(
      registry.size >= 20,
      `expected >=20 registered MCP tools in ${REGISTRY_DIR}, got ${registry.size}`,
    );
  });

  for (const rel of LLMS_FILES) {
    const text = readFileSync(join(ROOT, rel), 'utf-8');
    const cited = citedTools(text);

    it(`${rel} cites at least one MCP tool (section not silently dropped)`, () => {
      assert.ok(
        cited.length > 0,
        `${rel} names no MCP tools — did the "When to Use" agent-guidance section get removed?`,
      );
    });

    it(`${rel} only cites MCP tools that exist in api/mcp/registry`, () => {
      const unknown = cited.filter((t) => !registry.has(t));
      assert.deepEqual(
        unknown,
        [],
        `${rel} cites MCP tool(s) not in the registry (renamed or typo'd): ${unknown.join(', ')}`,
      );
    });
  }
});
