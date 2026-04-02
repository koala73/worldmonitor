/**
 * Regression tests for the digest-mode rollout flag paths.
 *
 * Covers three invariants reviewers flagged as untested:
 *   1. VITE_DIGEST_CRON_ENABLED gates digest-mode options in the settings UI.
 *   2. digestTimezone is validated through the public setDigestSettings mutation.
 *   3. digestTimezone is validated through the internal setDigestSettingsForUser
 *      mutation (the edge-to-Convex path bypasses the public mutation).
 *
 * Run: node --test tests/digest-rollout-flags.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prefSrc = readFileSync(
  resolve(__dirname, '../src/services/preferences-content.ts'),
  'utf-8',
);
const alertRulesSrc = readFileSync(
  resolve(__dirname, '../convex/alertRules.ts'),
  'utf-8',
);

// ── UI rollout flag ───────────────────────────────────────────────────────────

describe('VITE_DIGEST_CRON_ENABLED gates digest UI', () => {
  it('defines DIGEST_CRON_ENABLED from VITE_DIGEST_CRON_ENABLED env var', () => {
    assert.ok(
      prefSrc.includes("import.meta.env.VITE_DIGEST_CRON_ENABLED !== '0'"),
      'DIGEST_CRON_ENABLED must be derived from VITE_DIGEST_CRON_ENABLED',
    );
  });

  it('daily/twice_daily/weekly options are rendered only when flag is on', () => {
    assert.ok(
      prefSrc.includes("DIGEST_CRON_ENABLED ? `<option value=\"daily\""),
      'daily option must be gated behind DIGEST_CRON_ENABLED',
    );
    assert.ok(
      prefSrc.includes(`<option value="twice_daily"`),
      'twice_daily option must exist in the template',
    );
    assert.ok(
      prefSrc.includes(`<option value="weekly"`),
      'weekly option must exist in the template',
    );
    // All three non-realtime options are inside the DIGEST_CRON_ENABLED ternary block
    const gateIdx = prefSrc.indexOf('DIGEST_CRON_ENABLED ? `<option value="daily"');
    const dailyIdx = prefSrc.indexOf('<option value="daily"');
    const twiceIdx = prefSrc.indexOf('<option value="twice_daily"');
    const weeklyIdx = prefSrc.indexOf('<option value="weekly"');
    assert.ok(
      gateIdx !== -1 && dailyIdx > gateIdx && twiceIdx > gateIdx && weeklyIdx > gateIdx,
      'non-realtime options must appear after the DIGEST_CRON_ENABLED gate',
    );
  });

  it('usDigestDetails visibility is tied to DIGEST_CRON_ENABLED', () => {
    assert.ok(
      prefSrc.includes('!DIGEST_CRON_ENABLED || digestMode === \'realtime\''),
      'usDigestDetails must be hidden when DIGEST_CRON_ENABLED is false',
    );
  });

  it('realtime option is always rendered (fallback when cron is disabled)', () => {
    assert.ok(
      prefSrc.includes('<option value="realtime"'),
      'realtime option must always be present in the select',
    );
    // It must NOT be inside the DIGEST_CRON_ENABLED conditional block
    const realtimeIdx = prefSrc.indexOf('<option value="realtime"');
    const gateIdx = prefSrc.indexOf('DIGEST_CRON_ENABLED ? `<option value="daily"');
    assert.ok(
      realtimeIdx < gateIdx || gateIdx === -1,
      'realtime option must appear before (outside) the DIGEST_CRON_ENABLED gate',
    );
  });
});

// ── Public mutation timezone validation ───────────────────────────────────────

describe('setDigestSettings validates digestTimezone (public mutation)', () => {
  // Locate the setDigestSettings mutation body
  const publicStart = alertRulesSrc.indexOf('export const setDigestSettings');
  const nextExport = alertRulesSrc.indexOf('\nexport const ', publicStart + 1);
  const publicBody = alertRulesSrc.slice(publicStart, nextExport === -1 ? undefined : nextExport);

  it('setDigestSettings exists as a mutation', () => {
    assert.ok(publicStart !== -1, 'setDigestSettings must exist in alertRules.ts');
    assert.ok(publicBody.includes('mutation('), 'setDigestSettings must use mutation()');
  });

  it('public mutation validates digestTimezone with Intl.DateTimeFormat', () => {
    assert.ok(
      publicBody.includes('Intl.DateTimeFormat') && publicBody.includes('digestTimezone'),
      'setDigestSettings must validate digestTimezone via Intl.DateTimeFormat',
    );
  });

  it('public mutation throws ConvexError for invalid timezone', () => {
    assert.ok(
      publicBody.includes('ConvexError') && publicBody.includes('digestTimezone'),
      'setDigestSettings must throw ConvexError on invalid digestTimezone',
    );
  });
});

// ── Internal mutation timezone validation (edge-to-Convex path) ───────────────

describe('setDigestSettingsForUser validates digestTimezone (internalMutation)', () => {
  // Locate the setDigestSettingsForUser body
  const internalStart = alertRulesSrc.indexOf('export const setDigestSettingsForUser');
  const afterInternal = alertRulesSrc.indexOf('\nexport const ', internalStart + 1);
  const internalBody = alertRulesSrc.slice(
    internalStart,
    afterInternal === -1 ? undefined : afterInternal,
  );

  it('setDigestSettingsForUser exists as an internalMutation', () => {
    assert.ok(internalStart !== -1, 'setDigestSettingsForUser must exist in alertRules.ts');
    assert.ok(
      internalBody.includes('internalMutation('),
      'setDigestSettingsForUser must use internalMutation()',
    );
  });

  it('internal mutation validates digestTimezone with Intl.DateTimeFormat', () => {
    assert.ok(
      internalBody.includes('Intl.DateTimeFormat') && internalBody.includes('digestTimezone'),
      'setDigestSettingsForUser must validate digestTimezone — edge relay calls this path directly',
    );
  });

  it('internal mutation throws ConvexError for invalid timezone', () => {
    assert.ok(
      internalBody.includes('ConvexError') && internalBody.includes('digestTimezone'),
      'setDigestSettingsForUser must throw ConvexError on invalid digestTimezone',
    );
  });

  it('both public and internal mutations validate timezone (no bypass via internal path)', () => {
    const publicHasValidation = alertRulesSrc.slice(
      alertRulesSrc.indexOf('export const setDigestSettings'),
      alertRulesSrc.indexOf('export const setDigestSettingsForUser'),
    ).includes('Intl.DateTimeFormat');
    const internalHasValidation = internalBody.includes('Intl.DateTimeFormat');
    assert.ok(
      publicHasValidation && internalHasValidation,
      'digestTimezone validation must exist in BOTH setDigestSettings and setDigestSettingsForUser',
    );
  });
});
