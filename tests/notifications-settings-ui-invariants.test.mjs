/**
 * Regression tests for the (digestMode, sensitivity) invariant surface in
 * src/services/notifications-settings.ts.
 *
 * These are source-grep tests rather than Playwright tests — the settings
 * panel renders inline HTML strings via a long render function with no
 * exports, the same shape the relay carries (cf.
 * notification-relay-effective-sensitivity.test.mjs). Source-grep catches the
 * regressions that matter for this plan: layout placement, disable-on-realtime
 * state, snap-to-high logic, and atomic-save routing.
 *
 * See plans/forbid-realtime-all-events.md §2.
 *
 * Run: node --test tests/notifications-settings-ui-invariants.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(__dirname, '..', 'src', 'services', 'notifications-settings.ts'),
  'utf-8',
);

describe('notifications-settings.ts — sensitivity dropdown placement', () => {
  it('Sensitivity select renders OUTSIDE usRealtimeSection (visible in digest mode)', () => {
    // Locate the realtime section opener and the sensitivity select. The select
    // must appear at a lower offset (i.e. earlier in the source) than the
    // realtime-section opener.
    const realtimeSectionIdx = src.indexOf('id="usRealtimeSection"');
    const sensitivitySelectIdx = src.indexOf('id="usNotifSensitivity"');
    assert.ok(realtimeSectionIdx > 0, 'usRealtimeSection marker must exist');
    assert.ok(sensitivitySelectIdx > 0, 'usNotifSensitivity select must exist');
    assert.ok(
      sensitivitySelectIdx < realtimeSectionIdx,
      'Sensitivity select must render BEFORE the realtime section opener so digest-mode users can see it',
    );
  });

  it("'all' AND 'high' options both carry an isRealtime-conditional disabled attribute (tightened rule)", () => {
    // The all+high options must both be disabled when isRealtime is true. Under
    // the tightened rule (2026-04-27), only `critical` is allowed alongside
    // realtime. This catches the foot-gun without disable: user re-picking
    // (realtime, all) OR (realtime, high) through the UI.
    assert.match(
      src,
      /<option value="all"\$\{isRealtime \? ' disabled' : ''\}/,
      "the 'all' <option> must include `${isRealtime ? ' disabled' : ''}`",
    );
    assert.match(
      src,
      /<option value="high"\$\{isRealtime \? ' disabled' : ''\}/,
      "the 'high' <option> must include `${isRealtime ? ' disabled' : ''}`",
    );
  });

  it('helper text under sensitivity matches the server error wording', () => {
    // The helper text and the server error message must agree — divergence
    // confuses users who hit the constraint from different surfaces.
    assert.match(
      src,
      /Real-time delivery is for Critical events only/,
      'sensitivity helper text must match the server error wording',
    );
  });

  it('helper text is conditionally hidden in digest mode (Greptile P2)', () => {
    // The hint is only relevant when isRealtime — digest users would otherwise
    // see "Real-time delivery requires..." copy that doesn't apply to them.
    assert.match(
      src,
      /id="usSensitivityHint"\s+style="[^"]*\$\{isRealtime\s*\?\s*''\s*:\s*'display:none'\}/,
      'usSensitivityHint must conditionally hide via display:none when !isRealtime',
    );
    assert.match(
      src,
      /hintEl\.style\.display\s*=\s*isRt\s*\?\s*''\s*:\s*'none'/,
      'mode-change handler must toggle usSensitivityHint display on dimension change',
    );
  });
});

describe('notifications-settings.ts — mode-change behavior', () => {
  it("snaps sensitivity to 'critical' when switching TO realtime with sensitivity in {all, high} (tightened rule)", () => {
    // Under the tightened rule, both 'all' AND 'high' must trigger the snap.
    // The handler must snap the value AND ALSO record the snapped sensitivity
    // so the atomic save sends it to the server.
    assert.match(
      src,
      /isRt\s*&&\s*\(sensitivityEl\?\.value\s*===\s*'all'\s*\|\|\s*sensitivityEl\?\.value\s*===\s*'high'\)/,
      'mode-change must detect (switching to realtime) AND (current value is "all" OR "high")',
    );
    assert.match(
      src,
      /sensitivityEl\.value\s*=\s*'critical'/,
      "mode-change must set the dropdown value to 'critical' (was 'high' before the tightened rule)",
    );
    assert.match(
      src,
      /snappedSensitivity\s*=\s*'critical'/,
      "mode-change must record snappedSensitivity = 'critical' so the atomic save includes it",
    );
  });

  it("toggles BOTH 'all' AND 'high' option disabled attributes on mode change", () => {
    assert.match(
      src,
      /allOption\.disabled\s*=\s*isRt/,
      "mode-change handler must toggle allOption.disabled with isRt",
    );
    assert.match(
      src,
      /highOption\.disabled\s*=\s*isRt/,
      "mode-change handler must toggle highOption.disabled with isRt (tightened rule disables high too)",
    );
  });

  it('routes mode-change save through setNotificationConfig (atomic), NOT setDigestSettings', () => {
    // The atomic save was the whole point of the new wrapper. If the handler
    // still called setDigestSettings, we'd race against the cross-field validator
    // on (daily+all → realtime).
    const handlerStart = src.indexOf("target.id === 'usDigestMode'");
    assert.ok(handlerStart > 0, 'usDigestMode handler must exist');
    // Find the next handler boundary by searching for the next `target.id === '`
    // marker after handlerStart.
    const handlerEndCandidate = src.indexOf("target.id === '", handlerStart + 1);
    const handlerEnd = handlerEndCandidate > 0 ? handlerEndCandidate : src.length;
    const handlerBody = src.slice(handlerStart, handlerEnd);
    assert.match(
      handlerBody,
      /setNotificationConfig\(/,
      'usDigestMode handler must call setNotificationConfig for atomic pair-update save',
    );
    assert.doesNotMatch(
      handlerBody,
      /setDigestSettings\(/,
      'usDigestMode handler must NOT call setDigestSettings (races against the cross-field validator)',
    );
  });

  it('handles IncompatibleDeliveryError by surfacing the message in the helper hint', () => {
    assert.match(
      src,
      /err\s+instanceof\s+IncompatibleDeliveryError/,
      'mode-change save must catch IncompatibleDeliveryError specifically',
    );
  });
});
