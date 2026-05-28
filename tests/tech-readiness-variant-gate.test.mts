// Regression guard for PR #3833 follow-up: tech-readiness refresh must be
// variant-gated, not just viewport-gated.
//
// Bug: `shouldLoad(id)` returns `forceAll || isPanelNearViewport(id)` and
// `App.ts:1226` calls `loadAllData(true)` on boot — so a `shouldLoad`-only
// gate is bypassed at startup on every variant, and tech-readiness was
// still firing its 5s `/api/bootstrap?keys=techReadiness` fetch on
// commodity/finance/energy/happy where the seed key isn't populated.
//
// Fix: gate on `isPanelInVariantDefaults('tech-readiness')` in BOTH paths
// that auto-refresh — `data-loader.ts` (periodic + boot fan-out) and
// `panel-layout.ts` (lazyPanel factory's eager `p.refresh()` call).
//
// This test fails loudly if either gate is removed or weakened, even
// after innocent reformatting (line-walker, not strict regex).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readFile(rel: string): string[] {
  return readFileSync(resolve(root, rel), 'utf-8').split('\n');
}

function stripComments(line: string): string {
  // Strip // line comments before structural matching.
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

describe('tech-readiness variant gate', () => {
  it('data-loader.ts: tech-readiness task is gated by isPanelInVariantDefaults', () => {
    const lines = readFile('src/app/data-loader.ts');
    // Find the line that enqueues the techReadiness task.
    const taskLineIdx = lines.findIndex(l => /name:\s*'techReadiness'/.test(stripComments(l)));
    assert.ok(taskLineIdx !== -1, 'expected to find techReadiness task in data-loader.ts');

    // Walk backward to the enclosing `if (...)` on the same statement.
    let ifLineIdx = -1;
    for (let i = taskLineIdx; i >= Math.max(0, taskLineIdx - 5); i--) {
      if (/^\s*if\s*\(/.test(stripComments(lines[i]))) {
        ifLineIdx = i;
        break;
      }
    }
    assert.ok(ifLineIdx !== -1, 'expected an `if (...)` guarding the techReadiness task');

    // The condition must mention the variant-defaults helper, not just shouldLoad.
    const condition = stripComments(lines[ifLineIdx]);
    assert.match(
      condition,
      /isPanelInVariantDefaults\(\s*['"]tech-readiness['"]\s*\)/,
      `data-loader.ts:${ifLineIdx + 1} must gate techReadiness on isPanelInVariantDefaults('tech-readiness'); ` +
      `\`shouldLoad\` alone is bypassed on boot because loadAllData(true) forces it true. Got: ${condition.trim()}`,
    );
  });

  it("panel-layout.ts: lazyPanel('tech-readiness') factory only calls p.refresh() under the variant gate", () => {
    const lines = readFile('src/app/panel-layout.ts');
    // Find the lazyPanel registration for tech-readiness.
    const lazyIdx = lines.findIndex(l => /lazyPanel\(\s*['"]tech-readiness['"]/.test(stripComments(l)));
    assert.ok(lazyIdx !== -1, "expected lazyPanel('tech-readiness', ...) in panel-layout.ts");

    // Collect the factory body — walk forward until the call closes at column 0 with `);`.
    const body: { lineNo: number; text: string }[] = [];
    let depth = 0;
    let started = false;
    for (let i = lazyIdx; i < Math.min(lines.length, lazyIdx + 30); i++) {
      const text = stripComments(lines[i]);
      body.push({ lineNo: i + 1, text });
      for (const ch of text) {
        if (ch === '(') { depth++; started = true; }
        else if (ch === ')') { depth--; }
      }
      if (started && depth === 0) break;
    }
    assert.ok(body.length > 1, 'expected to walk the lazyPanel factory body');

    // Every line that calls `p.refresh()` must be preceded (within the body) by
    // a conditional that names isPanelInVariantDefaults('tech-readiness').
    const refreshLines = body.filter(b => /\bp\.refresh\(\s*\)/.test(b.text));
    assert.ok(
      refreshLines.length > 0,
      "expected the factory to call p.refresh() (currently the variant-gated initial fetch)",
    );

    const bodyText = body.map(b => b.text).join('\n');
    assert.match(
      bodyText,
      /if\s*\(\s*isPanelInVariantDefaults\(\s*['"]tech-readiness['"]\s*\)\s*\)\s*\{[^}]*\bp\.refresh\(\s*\)/s,
      "panel-layout.ts lazyPanel('tech-readiness', ...) factory must wrap p.refresh() in " +
      "`if (isPanelInVariantDefaults('tech-readiness')) { ... }`. Without the gate, " +
      'the factory fires the 5s /api/bootstrap?keys=techReadiness fetch on every variant ' +
      "regardless of whether the seed key exists.",
    );
  });

  it('panels.ts: isPanelInVariantDefaults is exported from @/config barrel', () => {
    const barrel = readFileSync(resolve(root, 'src/config/index.ts'), 'utf-8');
    assert.match(
      barrel,
      /isPanelInVariantDefaults/,
      'src/config/index.ts must re-export isPanelInVariantDefaults so call sites can import it from @/config',
    );
  });
});
