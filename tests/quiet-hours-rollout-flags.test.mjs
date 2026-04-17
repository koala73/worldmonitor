/**
 * Regression tests for the quiet-hours rollout flag paths.
 *
 * Covers three invariants reviewers flagged as untested:
 *   1. VITE_QUIET_HOURS_BATCH_ENABLED gates the batch_on_wake option in the UI.
 *   2. quietHoursTimezone is validated through the public setQuietHours mutation.
 *   3. quietHoursTimezone is validated through the internal setQuietHoursForUser
 *      mutation (the edge-to-Convex path bypasses the public mutation).
 *
 * Run: node --test tests/quiet-hours-rollout-flags.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prefSrc = readFileSync(
  resolve(__dirname, '../src/services/notifications-settings.ts'),
  'utf-8',
);
const alertRulesSrc = readFileSync(
  resolve(__dirname, '../convex/alertRules.ts'),
  'utf-8',
);

// ── UI rollout flag ───────────────────────────────────────────────────────────

describe('VITE_QUIET_HOURS_BATCH_ENABLED gates batch_on_wake UI', () => {
  it('defines QUIET_HOURS_BATCH_ENABLED from VITE_QUIET_HOURS_BATCH_ENABLED env var', () => {
    assert.ok(
      prefSrc.includes("import.meta.env.VITE_QUIET_HOURS_BATCH_ENABLED !== '0'"),
      'QUIET_HOURS_BATCH_ENABLED must be derived from VITE_QUIET_HOURS_BATCH_ENABLED',
    );
  });

  it('batch_on_wake option is conditionally rendered behind the flag', () => {
    assert.ok(
      prefSrc.includes('QUIET_HOURS_BATCH_ENABLED') && prefSrc.includes('batch_on_wake'),
      'batch_on_wake option must reference QUIET_HOURS_BATCH_ENABLED',
    );
    // The option must appear inside a QUIET_HOURS_BATCH_ENABLED conditional
    const gateIdx = prefSrc.indexOf('QUIET_HOURS_BATCH_ENABLED ?');
    const batchIdx = prefSrc.indexOf('<option value="batch_on_wake"');
    assert.ok(
      gateIdx !== -1 && batchIdx > gateIdx,
      'batch_on_wake option must appear after the QUIET_HOURS_BATCH_ENABLED gate',
    );
  });

  it('critical_only override option is always rendered (baseline when batch is disabled)', () => {
    assert.ok(
      prefSrc.includes('<option value="critical_only"'),
      'critical_only must always be present as the safe baseline override',
    );
    const criticalIdx = prefSrc.indexOf('<option value="critical_only"');
    const gateIdx = prefSrc.indexOf('QUIET_HOURS_BATCH_ENABLED ?');
    // critical_only must appear before (outside) the batch gate
    assert.ok(
      criticalIdx !== -1 && (gateIdx === -1 || criticalIdx < gateIdx),
      'critical_only option must appear before (outside) the QUIET_HOURS_BATCH_ENABLED gate',
    );
  });
});

// ── Public mutation timezone validation ───────────────────────────────────────

describe('setQuietHours validates quietHoursTimezone (public mutation)', () => {
  const publicStart = alertRulesSrc.indexOf('export const setQuietHours');
  const nextExport = alertRulesSrc.indexOf('\nexport const ', publicStart + 1);
  const publicBody = alertRulesSrc.slice(publicStart, nextExport === -1 ? undefined : nextExport);

  it('setQuietHours exists as a mutation', () => {
    assert.ok(publicStart !== -1, 'setQuietHours must exist in alertRules.ts');
    assert.ok(publicBody.includes('mutation('), 'setQuietHours must use mutation()');
  });

  it('public mutation validates quietHoursTimezone via validateQuietHoursArgs or Intl.DateTimeFormat', () => {
    const hasValidator =
      publicBody.includes('validateQuietHoursArgs') ||
      (publicBody.includes('Intl.DateTimeFormat') && publicBody.includes('quietHoursTimezone'));
    assert.ok(
      hasValidator,
      'setQuietHours must validate quietHoursTimezone',
    );
  });

  it('validateQuietHoursArgs validates with Intl.DateTimeFormat', () => {
    // Whether inlined or via helper, validation must use Intl.DateTimeFormat
    assert.ok(
      alertRulesSrc.includes('Intl.DateTimeFormat') && alertRulesSrc.includes('quietHoursTimezone'),
      'alertRules.ts must validate quietHoursTimezone using Intl.DateTimeFormat',
    );
  });

  it('timezone validation throws ConvexError for invalid values', () => {
    assert.ok(
      alertRulesSrc.includes('ConvexError') && alertRulesSrc.includes('quietHoursTimezone'),
      'alertRules.ts must throw ConvexError on invalid quietHoursTimezone',
    );
  });
});

// ── Internal mutation timezone validation (edge-to-Convex path) ───────────────

describe('setQuietHoursForUser validates quietHoursTimezone (internalMutation)', () => {
  const internalStart = alertRulesSrc.indexOf('export const setQuietHoursForUser');
  const afterInternal = alertRulesSrc.indexOf('\nexport const ', internalStart + 1);
  const internalBody = alertRulesSrc.slice(
    internalStart,
    afterInternal === -1 ? undefined : afterInternal,
  );

  it('setQuietHoursForUser exists as an internalMutation', () => {
    assert.ok(internalStart !== -1, 'setQuietHoursForUser must exist in alertRules.ts');
    assert.ok(
      internalBody.includes('internalMutation('),
      'setQuietHoursForUser must use internalMutation()',
    );
  });

  it('internal mutation validates quietHoursTimezone (no bypass via edge path)', () => {
    const hasValidator =
      internalBody.includes('validateQuietHoursArgs') ||
      (internalBody.includes('Intl.DateTimeFormat') && internalBody.includes('quietHoursTimezone'));
    assert.ok(
      hasValidator,
      'setQuietHoursForUser must validate quietHoursTimezone — edge relay calls this path directly',
    );
  });

  it('both public and internal mutations share the same validation path', () => {
    // If a shared validateQuietHoursArgs helper exists, both must call it
    if (alertRulesSrc.includes('function validateQuietHoursArgs')) {
      const publicBody = alertRulesSrc.slice(
        alertRulesSrc.indexOf('export const setQuietHours'),
        alertRulesSrc.indexOf('export const setQuietHoursForUser'),
      );
      assert.ok(
        publicBody.includes('validateQuietHoursArgs'),
        'setQuietHours must call validateQuietHoursArgs',
      );
      assert.ok(
        internalBody.includes('validateQuietHoursArgs'),
        'setQuietHoursForUser must also call validateQuietHoursArgs',
      );
    } else {
      // Both must have inline Intl.DateTimeFormat validation
      const publicHas = alertRulesSrc.slice(
        alertRulesSrc.indexOf('export const setQuietHours'),
        alertRulesSrc.indexOf('export const setQuietHoursForUser'),
      ).includes('Intl.DateTimeFormat');
      const internalHas = internalBody.includes('Intl.DateTimeFormat');
      assert.ok(
        publicHas && internalHas,
        'quietHoursTimezone validation must exist in BOTH setQuietHours and setQuietHoursForUser',
      );
    }
  });
});
