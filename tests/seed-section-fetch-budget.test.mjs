// Guard: a runSeed seeder's fetch-phase deadline must fit inside the bundle
// section timeout that spawns it (issue #8479).
//
// `_bundle-runner.mjs` SIGTERMs a section at its `timeoutMs`. `runSeed` races
// the fetch against `fetchDeadlineMs`, which defaults to `lockTtlMs + 120s`
// margin — a value tied to the lock, not the section. When that default
// outlasts the section, the runner kills the process mid-retry and the
// graceful fetch-failure path (last-good TTL extension, exit 75) never runs.
//
// #8429 fixed one CoinGecko instance by sizing that ladder by hand. This gate
// covers the class: the runner passes the section budget to the child, and
// `resolveFetchDeadlineMs` clamps the fetch deadline to leave publish /
// graceful-cleanup reserve before SIGTERM.
//
// Per registry entry, the first test pins the arithmetic for a known
// lock/section mismatch. The second proves the resolver returns a deadline
// strictly inside the section. A third proves the bundle runner injects the
// env var the resolver reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SECTION_TIMEOUT_MS } from '../scripts/_bundle-runner.mjs';
import {
  BUNDLE_SECTION_TIMEOUT_MS_ENV,
  FETCH_PHASE_DEADLINE_MARGIN_MS,
  FETCH_PHASE_PUBLISH_RESERVE_MS,
  resolveFetchDeadlineMs,
} from '../scripts/_seed-utils.mjs';
import { extractBundleSections, listBundleFiles, resolveExpr } from './helpers/bundle-section-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(resolve(__dirname, '..'), 'scripts');

/**
 * Seeders whose lock-derived (or explicit) fetch deadline was audited to
 * outlast their bundle section timeout. Adding an entry is the only step
 * needed to put another verified instance under this gate.
 */
const SECTION_BUDGET_SEEDERS = [
  {
    script: 'seed-mineral-production.mjs',
    // lockTtlMs: 180_000 with no fetchPhaseTimeoutMs → default deadline 300s
    // against Mineral-Production's 180s section (scripts/seed-bundle-static-ref-heavy.mjs).
    lockTtlMs: 180_000,
    fetchPhaseTimeoutMs: null,
  },
];

function readSeederSection(script) {
  const found = [];
  for (const bundlePath of listBundleFiles(SCRIPTS_DIR)) {
    const src = readFileSync(bundlePath, 'utf-8');
    for (const section of extractBundleSections(src)) {
      if (section.script !== script) continue;
      const timeoutMs = section.timeoutMsExpr == null
        ? DEFAULT_SECTION_TIMEOUT_MS
        : resolveExpr(src, section.timeoutMsExpr, {}, { file: bundlePath });
      found.push({ bundle: basename(bundlePath), label: section.label, timeoutMs });
    }
  }
  assert.equal(
    found.length,
    1,
    `expected exactly one bundle section with script: '${script}', found ${found.length} `
    + `(${JSON.stringify(found)}). If the seeder moved bundles, point this gate at the new section; if the parser `
    + 'dropped it, fix tests/helpers/bundle-section-parser.mjs rather than leaving the seeder unchecked.',
  );
  const [section] = found;
  assert.ok(
    Number.isFinite(section.timeoutMs) && section.timeoutMs > 0,
    `${section.bundle} / ${section.label}: timeoutMs did not resolve to a positive number (${section.timeoutMs})`,
  );
  return section;
}

function assertSeederNeedsClamp({ script, lockTtlMs, fetchPhaseTimeoutMs }) {
  const section = readSeederSection(script);
  const unconstrained = resolveFetchDeadlineMs({
    fetchPhaseTimeoutMs,
    lockTtlMs,
    sectionTimeoutMs: null,
  });
  assert.ok(
    unconstrained > section.timeoutMs,
    `${section.bundle} / ${section.label}: expected unconstrained fetch deadline ${unconstrained}ms to exceed `
    + `the section's ${section.timeoutMs}ms timeoutMs so this gate still documents a real mismatch. `
    + 'If the seeder was re-sized, update or remove the registry entry.',
  );
  assert.ok(
    unconstrained === (Number.isFinite(fetchPhaseTimeoutMs) && fetchPhaseTimeoutMs > 0
      ? fetchPhaseTimeoutMs
      : lockTtlMs + FETCH_PHASE_DEADLINE_MARGIN_MS),
    `${script}: unconstrained deadline must be the lock-derived (or explicit) value`,
  );
}

function assertClampFitsSection({ script, lockTtlMs, fetchPhaseTimeoutMs }) {
  const section = readSeederSection(script);
  const deadline = resolveFetchDeadlineMs({
    fetchPhaseTimeoutMs,
    lockTtlMs,
    sectionTimeoutMs: section.timeoutMs,
  });
  assert.ok(
    deadline + FETCH_PHASE_PUBLISH_RESERVE_MS <= section.timeoutMs,
    `${section.bundle} / ${section.label}: clamped fetch deadline ${deadline}ms + publish reserve `
    + `${FETCH_PHASE_PUBLISH_RESERVE_MS}ms = ${deadline + FETCH_PHASE_PUBLISH_RESERVE_MS}ms exceeds the `
    + `section's ${section.timeoutMs}ms timeoutMs. The runner would SIGTERM before graceful fetch failure `
    + 'or publish can finish.',
  );
  assert.ok(deadline > 0, `${script}: clamped deadline must stay positive`);
}

test('BUNDLE_SECTION_TIMEOUT_MS_ENV matches the name the runner injects', () => {
  assert.equal(BUNDLE_SECTION_TIMEOUT_MS_ENV, 'BUNDLE_SECTION_TIMEOUT_MS');
});

test('resolveFetchDeadlineMs: standalone (no section) keeps the lock-derived default', () => {
  assert.equal(
    resolveFetchDeadlineMs({ fetchPhaseTimeoutMs: null, lockTtlMs: 180_000, sectionTimeoutMs: null }),
    180_000 + FETCH_PHASE_DEADLINE_MARGIN_MS,
  );
});

test('resolveFetchDeadlineMs: standalone keeps an explicit fetchPhaseTimeoutMs', () => {
  assert.equal(
    resolveFetchDeadlineMs({ fetchPhaseTimeoutMs: 90_000, lockTtlMs: 180_000, sectionTimeoutMs: null }),
    90_000,
  );
});

test('resolveFetchDeadlineMs: clamps a lock-derived deadline that outlasts the section', () => {
  // Mineral-Production shape: 300s default vs 180s section.
  const deadline = resolveFetchDeadlineMs({
    fetchPhaseTimeoutMs: null,
    lockTtlMs: 180_000,
    sectionTimeoutMs: 180_000,
  });
  assert.equal(deadline, 180_000 - FETCH_PHASE_PUBLISH_RESERVE_MS);
});

test('resolveFetchDeadlineMs: does not raise an already-safe explicit deadline', () => {
  assert.equal(
    resolveFetchDeadlineMs({
      fetchPhaseTimeoutMs: 60_000,
      lockTtlMs: 180_000,
      sectionTimeoutMs: 180_000,
    }),
    60_000,
  );
});

test('resolveFetchDeadlineMs: clamps an explicit deadline that still outlasts the section', () => {
  assert.equal(
    resolveFetchDeadlineMs({
      fetchPhaseTimeoutMs: 200_000,
      lockTtlMs: 180_000,
      sectionTimeoutMs: 180_000,
    }),
    180_000 - FETCH_PHASE_PUBLISH_RESERVE_MS,
  );
});

test('resolveFetchDeadlineMs: section shorter than the publish reserve still yields a positive cap', () => {
  assert.equal(
    resolveFetchDeadlineMs({
      fetchPhaseTimeoutMs: null,
      lockTtlMs: 120_000,
      sectionTimeoutMs: 10_000,
    }),
    1,
  );
});

for (const entry of SECTION_BUDGET_SEEDERS) {
  test(`${entry.script}: unconstrained fetch deadline outlasts its bundle section (documents the mismatch)`, () => {
    assertSeederNeedsClamp(entry);
  });

  test(`${entry.script}: clamped fetch deadline leaves publish reserve inside the section timeout`, () => {
    assertClampFitsSection(entry);
  });
}
