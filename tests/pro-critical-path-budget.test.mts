import assert from 'node:assert/strict';
import { readFile, stat, readdir } from 'node:fs/promises';
import { describe, it } from 'node:test';

/**
 * Critical-path budget guard for the committed /pro build (#5396).
 *
 * public/pro is a committed build artifact: any PR that rebuilds the pro app
 * (a #5374-class change) can silently regress the page's critical path — grow
 * the modulepreloaded chunks, promote the 3MB Clerk bundle to eager, or add
 * render-blocking assets — and the only tripwire would be the weekly DebugBear
 * email, days later and averaged. These checks run at PR time against the
 * artifacts themselves, so the regression is named in CI, not in a report.
 *
 * The checks are pure functions over (html, sizeOf) so the same code that
 * guards the real artifacts is proven to have teeth against bad fixtures
 * below — a guard that cannot fail is not a guard.
 */

const PRO_DIR = new URL('../public/pro/', import.meta.url);

/** Render-blocking + pre-FCP fetch budget for /pro (entry, modulepreloads,
 *  stylesheets). Current path is ~625 KB (87 entry + 406 preload + 87 sentry
 *  + 45 css); 700 KB leaves growth headroom while catching a chunk-scale
 *  regression. Raising this number is a deliberate perf decision — cite the
 *  lab FCP/LCP impact in the PR that does it (#5396 baselines). */
const CRITICAL_PATH_BUDGET_BYTES = 700 * 1024;

/** Whole-assets cap: catches a second Clerk-scale dependency landing in the
 *  bundle even off the critical path. Current total is ~4.8 MB. */
const TOTAL_ASSETS_BUDGET_BYTES = 6 * 1024 * 1024;

interface CriticalRefs {
  entry: string;
  refs: string[];
}

/** Pure: extract local pre-FCP asset refs (entry script, modulepreloads,
 *  preloads, stylesheets) from the page HTML. External hosts (analytics) and
 *  async/defer scripts are not part of the critical path. */
function parseCriticalRefs(html: string): CriticalRefs {
  const refs = new Set<string>();
  let entry = '';
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    const srcMatch = tag.match(/\b(?:src|href)="(\/pro\/assets\/[^"]+)"/);
    if (!srcMatch) continue;
    const path = srcMatch[1]!;
    if (/^<script/.test(tag)) {
      if (/\basync\b|\bdefer\b/.test(tag)) continue;
      if (!entry) entry = path;
      refs.add(path);
    } else if (/rel="(?:stylesheet|modulepreload)"/.test(tag)) {
      refs.add(path);
    } else if (/rel="preload"/.test(tag) && /as="(?:style|script|font)"/.test(tag)) {
      refs.add(path);
    }
  }
  return { entry, refs: [...refs] };
}

/** Pure: throws when a Clerk chunk is referenced from the page HTML — the
 *  3MB bundle must never be script-src'd, preloaded, or modulepreloaded. */
function assertClerkNotOnCriticalPath(refs: string[]): void {
  const clerkRef = refs.find((r) => /\/clerk-[^/]*\.js$/.test(r));
  assert.equal(
    clerkRef,
    undefined,
    `Clerk chunk is on the /pro critical path (${clerkRef}): the ~3MB bundle must stay a lazy dynamic import — `
      + 'eager-loading it regressed the lab mobile score to 63 (#5396)',
  );
}

/** Pure: throws when the entry chunk stops importing Clerk dynamically —
 *  either the split was removed (inlined: catastrophic for parse cost) or the
 *  import became static (eager fetch). */
function assertClerkStaysLazy(entrySource: string): void {
  assert.doesNotMatch(
    entrySource,
    /(?:from\s*"\.\/clerk-|import"\.\/clerk-)/,
    'entry chunk imports Clerk statically — it must stay behind a dynamic import() (#5396)',
  );
  assert.match(
    entrySource,
    /import\("\.\/clerk-[^"]+"\)/,
    'entry chunk no longer contains the dynamic Clerk import — either Clerk was inlined into a bundled chunk '
      + '(3MB parse on every load) or the auth loader moved; re-anchor this guard on the new load path (#5396)',
  );
}

/** Pure: throws when the summed critical-path bytes exceed the budget. */
function assertCriticalPathBudget(refs: string[], sizeOf: (ref: string) => number): void {
  const total = refs.reduce((sum, r) => sum + sizeOf(r), 0);
  assert.ok(
    total <= CRITICAL_PATH_BUDGET_BYTES,
    `/pro critical path is ${Math.round(total / 1024)} KB (budget ${Math.round(CRITICAL_PATH_BUDGET_BYTES / 1024)} KB): `
      + `${refs.map((r) => `${r.split('/').pop()}=${Math.round(sizeOf(r) / 1024)}KB`).join(', ')} — `
      + 'raising the budget is a deliberate perf decision; cite lab FCP/LCP impact (#5396)',
  );
}

describe('pro critical path budget (#5396)', () => {
  it('keeps the real /pro page inside the critical-path budget', async () => {
    const html = await readFile(new URL('index.html', PRO_DIR), 'utf8');
    const { entry, refs } = parseCriticalRefs(html);
    assert.ok(entry, 'no entry <script> found in public/pro/index.html — parser or page structure changed');
    assert.ok(refs.length >= 2, `expected entry + preloads/styles on the critical path, found ${refs.length} refs`);

    const sizes = new Map<string, number>();
    for (const ref of refs) {
      const s = await stat(new URL(ref.replace('/pro/', './'), PRO_DIR));
      sizes.set(ref, s.size);
    }
    assertCriticalPathBudget(refs, (r) => sizes.get(r) ?? 0);
    assertClerkNotOnCriticalPath(refs);
  });

  it('keeps Clerk a lazy dynamic import in the real entry chunk', async () => {
    const html = await readFile(new URL('index.html', PRO_DIR), 'utf8');
    const { entry } = parseCriticalRefs(html);
    const entrySource = await readFile(new URL(entry.replace('/pro/', './'), PRO_DIR), 'utf8');
    assertClerkStaysLazy(entrySource);
  });

  it('keeps total /pro assets weight under the cap', async () => {
    const assetsDir = new URL('assets/', PRO_DIR);
    let total = 0;
    for (const name of await readdir(assetsDir)) {
      total += (await stat(new URL(name, assetsDir))).size;
    }
    assert.ok(
      total <= TOTAL_ASSETS_BUDGET_BYTES,
      `public/pro/assets is ${Math.round(total / 1024 / 1024 * 10) / 10} MB (cap ${TOTAL_ASSETS_BUDGET_BYTES / 1024 / 1024} MB) — `
        + 'a new heavyweight dependency landed in the pro bundle (#5396)',
    );
  });

  // Teeth: the same checkers must FAIL on the regressions they claim to catch.
  it('fails when Clerk is modulepreloaded (teeth)', () => {
    const html = '<script type="module" src="/pro/assets/index-abc.js"></script>'
      + '<link rel="modulepreload" href="/pro/assets/clerk-abc.js">';
    const { refs } = parseCriticalRefs(html);
    assert.throws(() => assertClerkNotOnCriticalPath(refs), /critical path/);
  });

  it('fails when the entry imports Clerk statically or loses the split (teeth)', () => {
    assert.throws(() => assertClerkStaysLazy('import{Clerk}from"./clerk-abc.js";'), /statically/);
    assert.throws(() => assertClerkStaysLazy('const x = 1; // no clerk anywhere'), /no longer contains/);
    assertClerkStaysLazy('async function load(){const{Clerk:n}=await import("./clerk-abc.js");}');
  });

  it('fails when the critical path exceeds the budget (teeth)', () => {
    const refs = ['/pro/assets/index-a.js', '/pro/assets/big-b.js'];
    assert.throws(
      () => assertCriticalPathBudget(refs, () => CRITICAL_PATH_BUDGET_BYTES),
      /budget/,
    );
  });
});
