// Static guard: in every budgeted `scripts/seed-bundle-*.mjs`, each section's
// worst-case wall time (`timeoutMs` + the runner's SIGTERM→SIGKILL grace) must
// fit `maxBundleMs`.
//
// Why this needs a CI gate rather than a code review:
//
// `_bundle-runner.mjs` admits a section only when
// `elapsed + timeoutMs + KILL_GRACE_MS <= maxBundleMs`. That check is a
// load-shed — it assumes the section fits the budget at all, and defers it to
// the next tick when the current one is too far along. A section whose worst
// case exceeds the WHOLE budget fails the check on every tick forever, and
// deferral is not an error, so the bundle still exits 0 and Railway paints
// SUCCESS.
//
// #6556: `seed-bundle-resilience` shipped `maxBundleMs: 570_000` alongside
// sections of 600s, 900s and 600s. The cheapest needed 610s. All three were
// deferred on every tick, `ran:0`, exit 0, green badge — and the service
// published nothing for six hours. The only detector was seed-meta ageing past
// a 14h staleness alarm, roughly fourteen hours after the service died.
//
// The runner now refuses to start on that config (see
// `findUnadmittableSections`), which turns the silent stall into a loud one.
// This gate is the earlier tripwire: it fails the PR that would deploy it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMISSION_HEADROOM_MS,
  DEFAULT_SECTION_TIMEOUT_MS,
  KILL_GRACE_MS,
  sectionWorstCaseMs,
} from '../scripts/_bundle-runner.mjs';
import {
  countSectionAnchors,
  countSectionScriptKeys,
  extractBundleOption,
  extractBundleSections,
  listBundleFiles,
  resolveExpr,
  stripLineComments,
} from './helpers/bundle-section-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(resolve(__dirname, '..'), 'scripts');

// Railway hard-kills a cron container at 10 minutes. Every wall budget exists
// to keep a section from being SIGKILLed mid-publish by that limit, so a budget
// at or above it is not a budget.
const RAILWAY_CONTAINER_CAP_MS = 600_000;

/**
 * Parse every bundle once. Throws rather than skipping on any unresolvable
 * value: a section this gate cannot read is a section it cannot vouch for,
 * and silently dropping it would turn the guard into a false pass.
 */
function readBudgetedBundles() {
  const budgeted = [];
  let sawMaxBundleMsLiteral = 0;

  for (const bundlePath of listBundleFiles(SCRIPTS_DIR)) {
    const name = basename(bundlePath);
    // Strip once: identifier resolution must not read a commented-out
    // declaration, and the anchor count must match what the extractor saw.
    const raw = readFileSync(bundlePath, 'utf-8');
    const src = stripLineComments(raw);
    // stripLineComments is a string scanner, not a JS tokenizer: it cannot tell
    // a comment from a regex literal, so `const RE = /[//]/` would swallow the
    // rest of the file. Both the extractor and the counts below read the
    // STRIPPED source, so that truncation hides sections from every check at
    // once and the gate passes on a file it never saw. Comparing the script-key
    // count across the strip is what makes that loud. A deliberately
    // commented-out section trips this too — delete it rather than commenting
    // it, so the gate keeps meaning what it says.
    assert.equal(
      countSectionScriptKeys(src),
      countSectionScriptKeys(raw),
      `${name}: ${countSectionScriptKeys(raw) - countSectionScriptKeys(src)} \`script:\` key(s) disappeared when `
      + 'comments were stripped. Either a section is commented out (delete it instead), or the stripper mis-read a '
      + 'regex literal and truncated the file. Either way this gate is not reading the real config.',
    );
    if (src.includes('maxBundleMs')) sawMaxBundleMsLiteral++;

    const budgetExpr = extractBundleOption(src, 'maxBundleMs');
    if (budgetExpr == null) continue;          // unbudgeted bundle — nothing to check

    // extractBundleOption takes the FIRST textual `maxBundleMs:` in the file.
    // A second one (a defaults object, a commented example that survived) would
    // make the gate check a budget the runner never uses.
    assert.equal(
      (src.match(/maxBundleMs:/g) || []).length,
      1,
      `${name}: expected exactly one maxBundleMs declaration, found `
      + `${(src.match(/maxBundleMs:/g) || []).length}. The gate cannot tell which one runBundle receives.`,
    );

    const maxBundleMs = resolveExpr(src, budgetExpr, {}, { file: bundlePath });
    assert.ok(
      Number.isFinite(maxBundleMs) && maxBundleMs > 0,
      `${name}: maxBundleMs expression "${budgetExpr}" did not resolve to a positive number. `
      + 'Extend tests/helpers/bundle-section-parser.mjs rather than leaving this bundle unchecked.',
    );
    // The budget only means anything if it is under the ceiling it exists to
    // stay beneath. Nothing else in the repo checks this: a bundle declaring
    // maxBundleMs 900_000 would satisfy every per-section assertion below and
    // still be hard-killed by Railway at 10 minutes, mid-publish.
    assert.ok(
      maxBundleMs < RAILWAY_CONTAINER_CAP_MS,
      `${name}: maxBundleMs ${maxBundleMs}ms is at or above Railway's ${RAILWAY_CONTAINER_CAP_MS}ms container kill. `
      + 'The container dies before the budget is reached, so the budget shapes nothing.',
    );

    const sections = extractBundleSections(src);
    assert.equal(
      sections.length,
      countSectionAnchors(src),
      `${name}: parsed ${sections.length} section(s) from ${countSectionAnchors(src)} \`{ label: ... }\` anchor(s). `
      + 'A dropped section is a silent pass — fix the parser before trusting this gate.',
    );
    // Second, independent count. The anchor check above shares its regex with
    // the extractor, so on its own it only proves the extractor agrees with
    // itself — a section the anchor cannot see is missing from both sides and
    // the equality still holds. `script:` is declared by every section and is
    // matched by a different pattern, so this is the check that actually
    // catches a section the gate never read.
    assert.equal(
      sections.length,
      countSectionScriptKeys(src),
      `${name}: parsed ${sections.length} section(s) but found ${countSectionScriptKeys(src)} \`script:\` key(s). `
      + 'The gate is not reading every declared section — fix the parser before trusting it.',
    );
    assert.ok(sections.length > 0, `${name} declares maxBundleMs but no parseable sections`);

    budgeted.push({
      name,
      maxBundleMs,
      sections: sections.map((section) => {
        const timeoutMs = section.timeoutMsExpr == null
          ? DEFAULT_SECTION_TIMEOUT_MS                 // runBundle's own fallback
          : resolveExpr(src, section.timeoutMsExpr, {}, { file: bundlePath });
        assert.ok(
          Number.isFinite(timeoutMs) && timeoutMs > 0,
          `${name} / ${section.label}: timeoutMs expression "${section.timeoutMsExpr}" did not resolve to a positive number.`,
        );
        // Call the runner's own helper rather than restating `timeoutMs +
        // KILL_GRACE_MS`. A gate that recomputes the formula it is guarding
        // stops guarding it the moment the formula changes.
        return { ...section, timeoutMs, worstCaseMs: sectionWorstCaseMs({ timeoutMs }) };
      }),
    });
  }

  assert.equal(
    budgeted.length,
    sawMaxBundleMsLiteral,
    `${sawMaxBundleMsLiteral} bundle(s) mention maxBundleMs but only ${budgeted.length} were parsed as budgeted. `
    + 'The option extractor missed one, so those bundles are going unchecked.',
  );
  return budgeted;
}

test('the kill grace is a real number, so the admission arithmetic cannot pass vacuously', () => {
  // `NaN > budget` is false, so a broken import would make every comparison
  // below succeed while proving nothing.
  assert.ok(Number.isFinite(KILL_GRACE_MS) && KILL_GRACE_MS > 0, 'KILL_GRACE_MS must be a positive number');
  assert.ok(Number.isFinite(DEFAULT_SECTION_TIMEOUT_MS) && DEFAULT_SECTION_TIMEOUT_MS > 0);
});

test('every budgeted bundle section fits its own bundle budget', () => {
  const budgeted = readBudgetedBundles();
  assert.ok(budgeted.length > 0, 'no budgeted bundle found — the gate would pass vacuously');

  const violations = [];
  let checked = 0;
  for (const bundle of budgeted) {
    for (const section of bundle.sections) {
      checked++;
      // Same threshold the runner enforces, headroom included. Comparing bare
      // worstCase against the budget would pass a section sized at exactly
      // `maxBundleMs - KILL_GRACE_MS`, which the runtime check then defers on
      // every tick forever — #6556 surviving its own gate.
      if (section.worstCaseMs + ADMISSION_HEADROOM_MS <= bundle.maxBundleMs) continue;
      violations.push(
        `${bundle.name} / ${section.label}: needs ${section.worstCaseMs + ADMISSION_HEADROOM_MS}ms `
        + `(timeoutMs ${section.timeoutMs} + ${KILL_GRACE_MS}ms kill grace + ${ADMISSION_HEADROOM_MS}ms admission headroom) `
        + `but maxBundleMs is ${bundle.maxBundleMs}ms — it can never be admitted. Lower timeoutMs to <= `
        + `${bundle.maxBundleMs - KILL_GRACE_MS - ADMISSION_HEADROOM_MS}, or raise the budget below Railway's `
        + '10-minute container cap.',
      );
    }
  }

  assert.ok(checked > 0, 'no sections checked — the parser is broken');
  assert.deepEqual(
    violations,
    [],
    `${violations.length} permanently-unadmittable bundle section(s) found:\n  - ${violations.join('\n  - ')}\n\n`
    + 'Such a section is deferred on every tick while the bundle exits 0, which is the #6556 silent stall.',
  );
});

test('seed-bundle-resilience admits Resilience-Scores on a cron tick (#6556 regression)', () => {
  // The acceptance criterion from the issue, pinned by name so a future edit
  // to this specific bundle cannot re-break the service the issue was about.
  const bundle = readBudgetedBundles().find((b) => b.name === 'seed-bundle-resilience.mjs');
  assert.ok(bundle, 'seed-bundle-resilience.mjs must declare a wall budget');

  for (const section of bundle.sections) {
    assert.ok(
      section.worstCaseMs + ADMISSION_HEADROOM_MS <= bundle.maxBundleMs,
      `${section.label} needs ${section.worstCaseMs + ADMISSION_HEADROOM_MS}ms of a ${bundle.maxBundleMs}ms budget — it would be deferred forever`,
    );
  }

  // Sections are offered the budget in array order, so the member that keeps
  // `resilience:ranking:v27` and `resilience:intervals:v10:*` alive between
  // cron fires has to be offered it first. Behind the annual Resilience-Static
  // or the monthly Food-Stocks it would be deferred on exactly the ticks those
  // heavier members are due — a partial rerun of #6556 that the per-section
  // arithmetic above cannot see.
  assert.equal(
    bundle.sections[0].label,
    'Resilience-Scores',
    'Resilience-Scores must be offered the wall budget before its heavier, rarer siblings',
  );
});
