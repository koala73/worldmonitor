import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Why this test exists (#6557)
// ---------------------------------------------------------------------------
//
// `Panel.showError()` sets three pieces of error state: the red `Error` chip on
// the header, a ticking auto-retry countdown, and the exponential backoff
// counter. `Panel` clears all three on a successful render — but only inside
// `setContentHtml` (via `setSafeContent`) and the two helpers added with this
// guard, `setContentNodes` and `setTrustedContent`.
//
// A panel that paints its own DOM bypasses every one of them. One transient
// failure then latches the `Error` chip over a full, correct dataset for the
// rest of the session, and leaves a countdown ticking toward a refresh the
// panel no longer needs. That is exactly what `cii` and `strategic-risk` did in
// production on 2026-08-13.
//
// `Panel.replaceContent()` has carried the docstring "Do not call
// `replaceChildren(this.content, …)` directly" for a long time with nothing
// enforcing it. This guard is the enforcement: the inventory below is the
// pre-#6557 legacy population, and it may only ever SHRINK.
//
// The guard is scoped to Panel subclasses (transitively). Classes with their
// own unrelated `content` field — `CountryDeepDivePanel`, `RouteExplorer` —
// have no Panel error state to latch and are correctly out of scope.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPONENTS_DIR = join(REPO_ROOT, 'src/components');

/**
 * Idioms that mutate panel content without going through `Panel`. Each one
 * skips the error-state clear that makes a render a recovery.
 *
 * This is an enumerated blocklist over source text, NOT an exhaustive one — a
 * green run means "no KNOWN direct-write idiom outside the legacy set", never
 * "a direct write is impossible". A local alias (`const el = this.content`)
 * still slips through. The list started at four idioms and missed
 * `MonitorPanel` and `PinnedWebcamsPanel` entirely, which is the argument for
 * widening it whenever a new idiom appears rather than reading silence as
 * proof.
 *
 * Additive idioms (`append`, `appendChild`, `removeChild`) are in scope on
 * purpose: appending a row onto a rendered `panel-error-state` leaves the chip
 * set just as surely as replacing the subtree does.
 */
const DIRECT_WRITE_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: 'replaceChildren(this.content, …)', re: /\breplaceChildren\(\s*this\.content\b/ },
  { label: 'setTrustedHtml(this.content, …)', re: /\bsetTrustedHtml\(\s*this\.content\b/ },
  { label: 'clearChildren(this.content)', re: /\bclearChildren\(\s*this\.content\b/ },
  { label: 'this.content.replaceChildren(…)', re: /\bthis\.content\.replaceChildren\(/ },
  { label: 'this.content.innerHTML = …', re: /\bthis\.content\.innerHTML\s*=/ },
  { label: 'this.content.textContent = …', re: /\bthis\.content\.textContent\s*=/ },
  { label: 'this.content.insertAdjacentHTML(…)', re: /\bthis\.content\.insertAdjacentHTML\(/ },
  { label: 'this.content.append(…)', re: /\bthis\.content\.append\(/ },
  { label: 'this.content.appendChild(…)', re: /\bthis\.content\.appendChild\(/ },
  { label: 'this.content.prepend(…)', re: /\bthis\.content\.prepend\(/ },
  { label: 'this.content.insertBefore(…)', re: /\bthis\.content\.insertBefore\(/ },
  { label: 'this.content.insertAdjacentElement(…)', re: /\bthis\.content\.insertAdjacentElement\(/ },
  { label: 'this.content.removeChild(…)', re: /\bthis\.content\.removeChild\(/ },
];

/**
 * Every `<file> :: <idiom>` pair in the pre-#6557 legacy population.
 *
 * Recorded PER WRITE, not per file, because a per-file inventory erodes: a file
 * with six direct writes that migrates only the one idiom the scan happened to
 * match would drop out of the observed set entirely, and the stale-entry test
 * below would then force it OFF the allowlist while five unmigrated writes
 * remained. Pairs also make adding a new idiom to an already-listed file fail,
 * which a per-file list cannot see.
 *
 * This list is a ratchet, not a permission slip:
 *   - a NEW pair fails the test — route the render through
 *     `setContentNodes` / `setTrustedContent` / `setSafeContent` instead;
 *   - a pair that no longer exists MUST be deleted, so the inventory can never
 *     quietly outlive the drift it records.
 *
 * Every entry is a latent instance of the #6557 latch for as long as it stays.
 * The confirmed-defect subset is tracked in #6577.
 */
const LEGACY_DIRECT_CONTENT_WRITES: readonly string[] = [
  'src/components/AirlineIntelPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/BreakthroughsTickerPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/BreakthroughsTickerPanel.ts :: this.content.appendChild(…)',
  'src/components/ChatAnalystPanel.ts :: replaceChildren(this.content, …)',
  'src/components/CorrelationPanel.ts :: replaceChildren(this.content, …)',
  'src/components/CountersPanel.ts :: this.content.appendChild(…)',
  'src/components/CountersPanel.ts :: this.content.innerHTML = …',
  'src/components/DeductionPanel.ts :: replaceChildren(this.content, …)',
  'src/components/DefensePatentsPanel.ts :: replaceChildren(this.content, …)',
  'src/components/GdeltIntelPanel.ts :: replaceChildren(this.content, …)',
  'src/components/GdeltIntelPanel.ts :: this.content.insertAdjacentElement(…)',
  'src/components/GivingPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/GoodThingsDigestPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/GoodThingsDigestPanel.ts :: this.content.appendChild(…)',
  'src/components/HeroSpotlightPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/InternetDisruptionsPanel.ts :: replaceChildren(this.content, …)',
  'src/components/LatestBriefPanel.ts :: clearChildren(this.content)',
  'src/components/LatestBriefPanel.ts :: replaceChildren(this.content, …)',
  'src/components/LatestBriefPanel.ts :: this.content.appendChild(…)',
  'src/components/LiveNewsPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/LiveNewsPanel.ts :: this.content.appendChild(…)',
  'src/components/LiveWebcamsPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/LiveWebcamsPanel.ts :: this.content.appendChild(…)',
  'src/components/MonitorPanel.ts :: clearChildren(this.content)',
  'src/components/MonitorPanel.ts :: this.content.appendChild(…)',
  'src/components/PinnedWebcamsPanel.ts :: this.content.appendChild(…)',
  'src/components/PinnedWebcamsPanel.ts :: this.content.removeChild(…)',
  'src/components/PositiveNewsFeedPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/ProgressChartsPanel.ts :: replaceChildren(this.content, …)',
  'src/components/ProgressChartsPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/ProgressChartsPanel.ts :: this.content.appendChild(…)',
  'src/components/ProgressChartsPanel.ts :: this.content.insertBefore(…)',
  'src/components/RegionalIntelligenceBoard.ts :: replaceChildren(this.content, …)',
  'src/components/RegulationPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/RenewableEnergyPanel.ts :: replaceChildren(this.content, …)',
  'src/components/RenewableEnergyPanel.ts :: this.content.appendChild(…)',
  'src/components/RuntimeConfigPanel.ts :: setTrustedHtml(this.content, …)',
  'src/components/ServiceStatusPanel.ts :: replaceChildren(this.content, …)',
  'src/components/SpeciesComebackPanel.ts :: replaceChildren(this.content, …)',
  'src/components/SpeciesComebackPanel.ts :: this.content.appendChild(…)',
  'src/components/SupplyChainPanel.ts :: this.content.prepend(…)',
  'src/components/TechEventsPanel.ts :: replaceChildren(this.content, …)',
  'src/components/TelegramIntelPanel.ts :: replaceChildren(this.content, …)',
];

/**
 * The panels #6557 migrated. Named so a future edit cannot re-list them.
 * `cii` and `strategic-risk` are the two seen latched in production; `cascade`
 * has the identical shape — a `showError()` in `init()` and a success
 * `render()` that painted `this.content` with no clear at all.
 */
const MIGRATED_BY_6557: readonly string[] = [
  'src/components/CIIPanel.ts',
  'src/components/CascadePanel.ts',
  'src/components/StrategicRiskPanel.ts',
];

/**
 * Floor for the Panel-subclass scan, derived from the 108 files it found at
 * #6557. A renamed base class or a moved directory would otherwise silently
 * shrink the population to zero and let every assertion below pass vacuously.
 */
const MIN_PANEL_SUBCLASS_FILES = 100;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...collectTsFiles(abs));
    else if (abs.endsWith('.ts')) out.push(abs);
  }
  return out.sort();
}

// `(?:<[^>]*>)?` so a generic subclass (`class Foo<T> extends Panel`) is not
// silently dropped from the population.
const CLASS_DECL = /\bclass\s+([A-Za-z0-9_$]+)(?:<[^>]*>)?\s+extends\s+([A-Za-z0-9_$]+)/g;

/** Base-class name for every class declared in `source`, keyed by class name. */
function collectClassBases(source: string): Map<string, string> {
  const bases = new Map<string, string>();
  for (const [, name, base] of source.matchAll(CLASS_DECL)) bases.set(name, base);
  return bases;
}

/**
 * Does `className` reach `Panel` through any number of `extends` hops?
 * `MilitaryCorrelationPanel extends CorrelationPanel extends Panel` carries the
 * same latch, so a one-hop scan would under-count the guarded population.
 */
function derivesFromPanel(className: string, baseOf: ReadonlyMap<string, string>): boolean {
  const seen = new Set<string>();
  for (let cursor: string | undefined = className; cursor; cursor = baseOf.get(cursor)) {
    if (cursor === 'Panel') return true;
    if (seen.has(cursor)) return false; // cycle guard
    seen.add(cursor);
  }
  return false;
}

/** Labels of every direct-write idiom present in `source`. */
function directWritesIn(source: string): string[] {
  return DIRECT_WRITE_PATTERNS.filter(({ re }) => re.test(source)).map(({ label }) => label);
}

const ALL_COMPONENT_FILES = collectTsFiles(COMPONENTS_DIR);
const SOURCE_BY_FILE = new Map(ALL_COMPONENT_FILES.map((abs) => [abs, readFileSync(abs, 'utf8')]));

const BASE_OF = new Map<string, string>();
for (const source of SOURCE_BY_FILE.values()) {
  for (const [name, base] of collectClassBases(source)) BASE_OF.set(name, base);
}

const PANEL_SUBCLASS_FILES: string[] = ALL_COMPONENT_FILES.filter((abs) =>
  [...collectClassBases(SOURCE_BY_FILE.get(abs) ?? '').keys()].some((name) =>
    derivesFromPanel(name, BASE_OF),
  ),
);

/** `<repo-relative path> :: <idiom>` for every direct write in a Panel subclass. */
const OBSERVED_DIRECT_WRITES: string[] = PANEL_SUBCLASS_FILES.flatMap((abs) =>
  directWritesIn(SOURCE_BY_FILE.get(abs) ?? '').map(
    (label) => `${relative(REPO_ROOT, abs)} :: ${label}`,
  ),
).sort();

const OBSERVED_FILES = new Set(OBSERVED_DIRECT_WRITES.map((pair) => pair.split(' :: ')[0]));

describe('Panel content-write invariant (#6557)', () => {
  it('sees the whole Panel subclass population', () => {
    // Without this the scan could silently match nothing (a moved directory, a
    // renamed base class) and every assertion below would pass vacuously.
    assert.ok(
      PANEL_SUBCLASS_FILES.length >= MIN_PANEL_SUBCLASS_FILES,
      `expected >= ${MIN_PANEL_SUBCLASS_FILES} Panel subclass files (108 at #6557), found ${PANEL_SUBCLASS_FILES.length} — the scan or the base-class name has drifted`,
    );
    assert.ok(
      OBSERVED_DIRECT_WRITES.length > 0,
      'the direct-write patterns matched nothing — the patterns have gone stale',
    );
  });

  it('detects a direct write in synthetic source', () => {
    // Proves the scanner has teeth independently of the tree: if these regexes
    // silently stopped matching, every other assertion here would pass while
    // the invariant went unenforced.
    for (const { label, re } of DIRECT_WRITE_PATTERNS) {
      assert.ok(re.source.length > 0, `${label} has an empty pattern`);
    }
    assert.deepEqual(
      directWritesIn('class Probe extends Panel { r() { replaceChildren(this.content, x); } }'),
      ['replaceChildren(this.content, …)'],
    );
    assert.deepEqual(
      directWritesIn('class Probe extends Panel { r() { clearChildren(this.content); } }'),
      ['clearChildren(this.content)'],
    );
    assert.deepEqual(directWritesIn('this.setContentNodes(row); this.setSafeContent(html);'), []);

    const bases = collectClassBases('export default class Deep<T> extends CorrelationPanel {}');
    bases.set('CorrelationPanel', 'Panel');
    assert.equal(derivesFromPanel('Deep', bases), true, 'transitive + generic subclass must be in scope');
    assert.equal(derivesFromPanel('Unrelated', bases), false);
  });

  it('no Panel subclass writes this.content outside the recorded legacy set', () => {
    const allowed = new Set(LEGACY_DIRECT_CONTENT_WRITES);
    const unlisted = OBSERVED_DIRECT_WRITES.filter((pair) => !allowed.has(pair));

    assert.deepEqual(
      unlisted,
      [],
      'These Panel subclasses mutate this.content directly, so a transient showError() ' +
        'latches the header Error chip over correct data (#6557). Render through ' +
        'Panel.setContentNodes() / setTrustedContent() / setSafeContent() instead:\n  ' +
        unlisted.join('\n  '),
    );
  });

  it('the legacy set has no stale entries — it may only shrink', () => {
    const observed = new Set(OBSERVED_DIRECT_WRITES);
    const stale = LEGACY_DIRECT_CONTENT_WRITES.filter((pair) => !observed.has(pair));

    assert.deepEqual(
      stale,
      [],
      'These writes no longer exist. Delete them from LEGACY_DIRECT_CONTENT_WRITES ' +
        'so the inventory keeps matching reality:\n  ' +
        stale.join('\n  '),
    );
  });

  it('the panels migrated by #6557 still render through Panel', () => {
    // Grounded in the live scan, not just the allowlist: a revert that puts a
    // direct write back into one of these files fails here even if nobody
    // touches LEGACY_DIRECT_CONTENT_WRITES.
    const regressed = MIGRATED_BY_6557.filter((file) => OBSERVED_FILES.has(file));
    assert.deepEqual(
      regressed,
      [],
      `${regressed.join(', ')} — migrated off direct writes by #6557 and must keep ` +
        'rendering through Panel.setContentNodes() / setTrustedContent().',
    );

    const relisted = MIGRATED_BY_6557.filter((file) =>
      LEGACY_DIRECT_CONTENT_WRITES.some((pair) => pair.startsWith(`${file} ::`)),
    );
    assert.deepEqual(
      relisted,
      [],
      `${relisted.join(', ')} — must not be re-added to the legacy inventory to silence the guard.`,
    );
  });

  it('Panel exposes the sanctioned success-write helpers', () => {
    const panelSource = SOURCE_BY_FILE.get(join(COMPONENTS_DIR, 'Panel.ts')) ?? '';

    // The escape hatch the guard points people at must exist, must clear the
    // error state, and must respect the lock — otherwise the migration it
    // forces is either a no-op or a paywall hole.
    for (const helper of ['setContentNodes', 'setTrustedContent']) {
      const body = panelSource.match(
        new RegExp(`protected ${helper}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\}`),
      );
      assert.ok(body, `Panel.${helper} is missing — the guard has nothing to point call sites at`);
      // Strip comments so a commented-out call cannot satisfy the assertion.
      const code = body[1].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.match(
        code,
        /this\.clearErrorState\(\)/,
        `Panel.${helper} must clear the error state, or a recovery render still latches the chip`,
      );
      assert.match(
        code,
        /if\s*\(this\._locked\)\s*return/,
        `Panel.${helper} must bail when the panel is locked, matching setContentHtml — a gated panel must not paint premium content over its upgrade CTA`,
      );
    }
  });
});
