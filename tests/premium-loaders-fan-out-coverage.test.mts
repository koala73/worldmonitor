import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// REGRESSION GUARD for PR #3828 (Free→Pro hydration race).
//
// `App.ts:firePremiumLoaders` fans out PRO-gated loaders on the Free→Pro
// entitlement transition. If a NEW loader is gated behind
// `hasPremiumAccess() && shouldLoad('X')` in `data-loader.ts` but a
// corresponding `this.dataLoader.loadX()` line is missing from
// `firePremiumLoaders`, the panel sits empty for the WHOLE SESSION on any
// variant where the scheduled refresh isn't registered (the stock-analysis /
// stock-backtest / daily-market-brief / market-implications schedulers are
// gated to SITE_VARIANT === 'finance').
//
// This test extracts the gated loader names from data-loader.ts and asserts
// each appears in firePremiumLoaders. It's deliberately static-grep based so
// it catches the omission at the moment of commit, without needing to wire
// up the full App.ts runtime.

const REPO_ROOT = resolve(import.meta.dirname, '..');
const APP_TS = readFileSync(resolve(REPO_ROOT, 'src/App.ts'), 'utf8');
const DATA_LOADER_TS = readFileSync(resolve(REPO_ROOT, 'src/app/data-loader.ts'), 'utf8');

// Loaders we deliberately do NOT include in the fan-out, with rationale.
// Add an entry here (not silently in source) if you skip a loader.
const ALLOWLIST: Record<string, string> = {
  // None today. Format: `loaderName: 'why this is intentionally excluded'`.
};

/** Pull every `this.loadX()` call that sits inside an `if (hasPremiumAccess(...))` gate. */
function extractGatedLoaders(src: string): Set<string> {
  const loaders = new Set<string>();
  const callRe = /this\.load([A-Z][A-Za-z0-9]+)\(\)/g;
  const addCallsFromBlock = (block: string): void => {
    for (const c of block.matchAll(callRe)) loaders.add(`load${c[1]}`);
  };

  // Three gate shapes appear in data-loader.ts and all three strand the
  // loader on boot if Pro hasn't hydrated yet:
  //   (a) `if (hasPremiumAccess() && shouldLoad('X')) { tasks.push(...load...()) }`
  //   (b) `if (hasPremiumAccess()) { await Promise.allSettled([this.load...()]) }`
  //   (c) `if (hasPremiumAccess() && shouldLoad('X')) tasks.push(...);`  ← single-line, no braces
  //
  // Regex with nested parens (a/c) and balanced braces (a/b) is fragile —
  // PR #3828 review caught the original regex only matching shape (b)
  // (the other loaders happened to appear via an init()-handler block that
  // ALSO matches shape (b), giving false confidence). Walk line-by-line
  // instead: find every line containing `hasPremiumAccess(`, then collect
  // calls from that line PLUS the subsequent block (braced or single-line).
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/\bhasPremiumAccess\(/.test(line)) continue;
    if (!/^\s*(?:if|else if)\s*\(/.test(line)) continue;   // only `if` gates, not call sites in other contexts

    addCallsFromBlock(line);   // single-line gates (shape c)

    // If the gate ends with `{`, collect from following lines until matching `}`.
    if (/\{\s*$/.test(line)) {
      let depth = 1;
      for (let j = i + 1; j < lines.length && depth > 0; j++) {
        const inner = lines[j]!;
        addCallsFromBlock(inner);
        for (const ch of inner) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          if (depth === 0) break;
        }
      }
    }
  }
  return loaders;
}

/** Pull every `void this.dataLoader.loadX()` call from inside the firePremiumLoaders block. */
function extractFanOutLoaders(src: string): Set<string> {
  const start = src.indexOf('const firePremiumLoaders');
  assert.ok(start >= 0, 'could not locate firePremiumLoaders in App.ts — refactor would silently bypass this guard');
  // Match until the closing `};` of the function body. The function ends with `_prevHadPremium = nowPremium;\n    };`.
  const end = src.indexOf('\n    };', start);
  assert.ok(end > start, 'could not locate end of firePremiumLoaders block');
  const block = src.slice(start, end);

  const loaders = new Set<string>();
  const re = /void\s+this\.dataLoader\.load([A-Z][A-Za-z0-9]+)\(\)/g;
  for (const match of block.matchAll(re)) {
    loaders.add(`load${match[1]}`);
  }
  return loaders;
}

describe('firePremiumLoaders fan-out coverage', () => {
  const gatedLoaders = extractGatedLoaders(DATA_LOADER_TS);
  const fanOutLoaders = extractFanOutLoaders(APP_TS);

  it('PR #3828 review fix: extracts loaders from single-line gates (no braces)', () => {
    // Synthetic fixture covering all three shapes the production regex must
    // handle. If a future "simplification" of the regex drops shape (c) again,
    // this test fails immediately with a clear message instead of giving a
    // false-positive pass on the production source.
    const fixture = `
    // (a) braced + viewport gate
    if (hasPremiumAccess() && shouldLoad('a-panel')) {
      tasks.push({ name: 'a', task: runGuarded('a', () => this.loadAaa()) });
    }
    // (b) braced + premium-only
    if (hasPremiumAccess()) {
      await Promise.allSettled([
        this.loadBbb(),
        this.loadCcc(),
      ]);
    }
    // (c) single-line, NO braces — the shape #3828 review caught me missing
    if (hasPremiumAccess() && shouldLoad('d-panel')) tasks.push({ name: 'd', task: runGuarded('d', () => this.loadDdd()) });
    `;
    const extracted = extractGatedLoaders(fixture);
    assert.ok(extracted.has('loadAaa'), 'missed shape (a) braced + viewport gate');
    assert.ok(extracted.has('loadBbb'), 'missed shape (b) braced + premium-only [first call]');
    assert.ok(extracted.has('loadCcc'), 'missed shape (b) braced + premium-only [second call]');
    assert.ok(extracted.has('loadDdd'), 'missed shape (c) single-line gate — fan-out coverage would have a blind spot');
  });

  it('extracts at least one PRO-gated loader from data-loader.ts (sanity)', () => {
    // If this fails, the regex stopped matching — likely because data-loader.ts
    // changed the gate shape (e.g. `hasPremiumAccess()` got replaced or moved).
    // Update extractGatedLoaders before bumping this test or you risk silently
    // turning off the coverage check.
    assert.ok(gatedLoaders.size > 0, `no PRO-gated loaders found via regex — gate-shape changed?`);
  });

  it('extracts at least one fan-out loader from App.ts (sanity)', () => {
    assert.ok(fanOutLoaders.size > 0, 'firePremiumLoaders has no `void this.dataLoader.loadX()` calls — has the function been renamed?');
  });

  it('every PRO-gated loader is fanned out on Free→Pro transition', () => {
    const missing: string[] = [];
    for (const loader of gatedLoaders) {
      if (fanOutLoaders.has(loader)) continue;
      if (loader in ALLOWLIST) continue;
      missing.push(loader);
    }
    assert.deepEqual(
      missing,
      [],
      `${missing.length} PRO-gated loader(s) in data-loader.ts are NOT re-fired by App.ts firePremiumLoaders on Free→Pro transition:\n` +
      missing.map((l) => `  - ${l}`).join('\n') +
      `\n\nFix: add \`void this.dataLoader.${missing[0] ?? 'loadX'}();\` to the firePremiumLoaders block in App.ts.\n` +
      `If you intentionally do NOT want this loader re-fired (e.g. it has its own entitlement subscription),\n` +
      `add it to the ALLOWLIST in this test with a one-line rationale.`,
    );
  });
});
