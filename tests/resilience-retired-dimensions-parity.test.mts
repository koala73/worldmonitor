import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  RESILIENCE_RETIRED_DIMENSIONS,
  RESILIENCE_NOT_APPLICABLE_WHEN_ZERO_COVERAGE,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers';

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

function parseClientSet(constName: string): Set<string> {
  const source = readFileSync(WIDGET_UTILS_PATH, 'utf8');
  // Allow optional `export ` prefix and tolerate whitespace.
  const re = new RegExp(`(?:export\\s+)?const\\s+${constName}:\\s*ReadonlySet<string>\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`);
  const match = source.match(re);
  if (!match) {
    throw new Error(
      `Could not locate ${constName} constant in resilience-widget-utils.ts. ` +
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
    const clientSet = parseClientSet('RESILIENCE_RETIRED_DIMENSION_IDS');

    const serverOnly = [...serverSet].filter((id) => !clientSet.has(id));
    const clientOnly = [...clientSet].filter((id) => !serverSet.has(id));

    assert.deepEqual(serverOnly, [],
      `Server-only retired dims: ${serverOnly.join(', ')}. Update RESILIENCE_RETIRED_DIMENSION_IDS in src/components/resilience-widget-utils.ts.`);
    assert.deepEqual(clientOnly, [],
      `Client-only retired dims: ${clientOnly.join(', ')}. Update RESILIENCE_RETIRED_DIMENSIONS in server/worldmonitor/resilience/v1/_dimension-scorers.ts.`);
  });

  // Plan 2026-04-26-001 §U3 (+ review fixup): mirror parity for the
  // not-applicable-when-zero-coverage set. Same divergence risk as
  // RETIRED — server filters out non-SWF coverage=0 rows from
  // computeOverallCoverage, and the widget MUST mirror or the
  // displayed Coverage % will diverge from the server's overallCoverage
  // for non-SWF advanced economies.
  it('server RESILIENCE_NOT_APPLICABLE_WHEN_ZERO_COVERAGE matches client RESILIENCE_NOT_APPLICABLE_WHEN_ZERO_COVERAGE_IDS', () => {
    const serverSet = new Set<string>(RESILIENCE_NOT_APPLICABLE_WHEN_ZERO_COVERAGE);
    const clientSet = parseClientSet('RESILIENCE_NOT_APPLICABLE_WHEN_ZERO_COVERAGE_IDS');

    const serverOnly = [...serverSet].filter((id) => !clientSet.has(id));
    const clientOnly = [...clientSet].filter((id) => !serverSet.has(id));

    assert.deepEqual(serverOnly, [],
      `Server-only not-applicable dims: ${serverOnly.join(', ')}. Update RESILIENCE_NOT_APPLICABLE_WHEN_ZERO_COVERAGE_IDS in src/components/resilience-widget-utils.ts.`);
    assert.deepEqual(clientOnly, [],
      `Client-only not-applicable dims: ${clientOnly.join(', ')}. Update RESILIENCE_NOT_APPLICABLE_WHEN_ZERO_COVERAGE in server/worldmonitor/resilience/v1/_dimension-scorers.ts.`);
  });
});

// Plan 2026-04-26-002 §U1: shape validation for cohort JSON fixtures.
// Standalone describe block (different concern from retired/not-applicable
// parity above) but kept in the same file so all "shape-of-data must
// match the schema" gates live together.
import { readdirSync } from 'node:fs';
const COHORTS_DIR = resolve(here, '../server/worldmonitor/resilience/v1/cohorts');
const ISO2_RE = /^[A-Z]{2}$/;

interface CohortShape {
  name: string;
  description: string;
  iso2: string[];
}

describe('cohort JSON fixture shapes (Plan 2026-04-26-002 §U1)', () => {
  const files = readdirSync(COHORTS_DIR).filter((f) => f.endsWith('.json'));

  it('cohorts directory contains at least the 5 expected files', () => {
    const required = ['g7.json', 'nordics.json', 'gcc.json', 'sub-saharan-lic.json', 'microstate-territories.json'];
    for (const req of required) {
      assert.ok(files.includes(req), `Missing required cohort fixture: ${req}`);
    }
  });

  for (const file of files) {
    it(`${file}: parses to {name, description, iso2[]} with valid ISO2 codes`, () => {
      const raw = readFileSync(resolve(COHORTS_DIR, file), 'utf8');
      let parsed: CohortShape;
      try {
        parsed = JSON.parse(raw) as CohortShape;
      } catch (err) {
        throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
      }
      assert.ok(typeof parsed.name === 'string' && parsed.name.length > 0,
        `${file} missing required "name" field`);
      assert.ok(typeof parsed.description === 'string' && parsed.description.length > 50,
        `${file} description must explain the cohort's purpose (got ${parsed.description?.length ?? 0} chars)`);
      assert.ok(Array.isArray(parsed.iso2) && parsed.iso2.length > 0,
        `${file} must have non-empty iso2[]`);
      for (const iso of parsed.iso2) {
        assert.ok(ISO2_RE.test(iso),
          `${file} contains invalid ISO2 code "${iso}" (must match /^[A-Z]{2}$/)`);
      }
      const set = new Set(parsed.iso2);
      assert.equal(set.size, parsed.iso2.length,
        `${file} contains duplicate ISO2 entries`);
    });
  }
});
