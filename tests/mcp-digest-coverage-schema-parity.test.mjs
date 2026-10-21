// #7084: the same digestCoverage field must be declared identically wherever
// an MCP tool exposes it.
//
// `staleAgeSeconds` shipped as JSON Schema `integer` in nlp-tools.ts and
// `number` in rpc-tools.ts, for the identical server-computed value, in a PR
// carrying 18+ new tests. Nothing caught it because nothing compared the two
// registries to each other — each was internally consistent.
//
// The proto is the source of truth: `int32 stale_age_seconds = 15`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/mcp.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Every tool in the live registry that publishes a digestCoverage block. */
function digestCoverageSchemas() {
  const found = [];
  for (const tool of __testing__.TOOL_REGISTRY) {
    const direct = tool.outputSchema?.properties?.digestCoverage?.properties;
    if (direct) found.push({ tool: tool.name, props: direct });
  }
  return found;
}

describe('digestCoverage schema parity across MCP tools (#7084)', () => {
  it('exposes digestCoverage on more than one tool, or this guard is vacuous', () => {
    const schemas = digestCoverageSchemas();
    assert.ok(
      schemas.length >= 2,
      `parity needs at least two declarations to compare; found ${schemas.length}: ` +
        schemas.map((s) => s.tool).join(', '),
    );
  });

  it('declares every shared field with the same type in every tool', () => {
    const schemas = digestCoverageSchemas();
    const byField = new Map();
    for (const { tool, props } of schemas) {
      for (const [field, spec] of Object.entries(props)) {
        if (!byField.has(field)) byField.set(field, []);
        byField.get(field).push({ tool, type: spec.type });
      }
    }
    for (const [field, declarations] of byField) {
      if (declarations.length < 2) continue;
      const types = [...new Set(declarations.map((d) => d.type))];
      assert.equal(
        types.length, 1,
        `digestCoverage.${field} is declared as ${types.join(' vs ')} across ` +
          declarations.map((d) => `${d.tool}=${d.type}`).join(', '),
      );
    }
  });

  it('types staleAgeSeconds as an integer, matching the proto int32', () => {
    const proto = readFileSync(
      resolve(here, '..', 'proto', 'worldmonitor', 'news', 'v1', 'list_feed_digest.proto'),
      'utf8',
    );
    assert.match(
      proto, /int32 stale_age_seconds = 15;/,
      'the proto is the source of truth for this field type',
    );
    for (const { tool, props } of digestCoverageSchemas()) {
      if (!props.staleAgeSeconds) continue;
      assert.equal(
        props.staleAgeSeconds.type, 'integer',
        `${tool} must declare staleAgeSeconds as integer to match the proto int32`,
      );
    }
  });
});
