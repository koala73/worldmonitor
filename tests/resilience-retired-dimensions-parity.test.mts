import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { RESILIENCE_RETIRED_DIMENSIONS } from '../server/worldmonitor/resilience/v1/_dimension-scorers';

// Keep the client-side mirror (`RESILIENCE_RETIRED_DIMENSION_IDS` in
// src/components/resilience-widget-utils.ts) in lockstep with the
// server-side authoritative set. Server and widget cannot share a
// module, but their retired-dim view must never diverge — divergence
// would leave one surface filtering the wrong set and re-introduce
// the PR 3 §3.5 drag regression on that surface.
//
// We parse the widget file as text (rather than importing it) because
// the widget module indirectly pulls in browser-only types that crash
// a plain node test runner. Same pattern as existing widget-util tests.

const here = dirname(fileURLToPath(import.meta.url));
const WIDGET_UTILS_PATH = resolve(here, '../src/components/resilience-widget-utils.ts');

function parseClientRetiredIds(): Set<string> {
  const source = readFileSync(WIDGET_UTILS_PATH, 'utf8');
  const match = source.match(
    /const RESILIENCE_RETIRED_DIMENSION_IDS:\s*ReadonlySet<string>\s*=\s*new Set\(\[([^\]]*)\]\)/,
  );
  if (!match) {
    throw new Error(
      'Could not locate RESILIENCE_RETIRED_DIMENSION_IDS constant in resilience-widget-utils.ts. ' +
      'If the constant was renamed or reformatted, update this parser to match.',
    );
  }
  // Strip line comments (// …) from the array body so a reviewer can
  // drop an inline rationale without breaking parity. Block comments
  // inside a const array are unusual enough we don't handle them.
  const body = match[1]!.replace(/\/\/[^\n]*/g, '');
  const ids = body
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^['"]|['"]$/g, ''));
  return new Set(ids);
}

describe('retired-dimensions client/server parity', () => {
  it('server RESILIENCE_RETIRED_DIMENSIONS matches client RESILIENCE_RETIRED_DIMENSION_IDS', () => {
    const serverSet = new Set<string>(RESILIENCE_RETIRED_DIMENSIONS);
    const clientSet = parseClientRetiredIds();

    const serverOnly = [...serverSet].filter((id) => !clientSet.has(id));
    const clientOnly = [...clientSet].filter((id) => !serverSet.has(id));

    assert.deepEqual(serverOnly, [],
      `Server-only retired dims: ${serverOnly.join(', ')}. Update RESILIENCE_RETIRED_DIMENSION_IDS in src/components/resilience-widget-utils.ts.`);
    assert.deepEqual(clientOnly, [],
      `Client-only retired dims: ${clientOnly.join(', ')}. Update RESILIENCE_RETIRED_DIMENSIONS in server/worldmonitor/resilience/v1/_dimension-scorers.ts.`);
  });
});
