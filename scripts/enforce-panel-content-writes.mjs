#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Panel content-write guard (#6557)
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
// This runs as a `lint:*` script rather than only as a test because the edit it
// must catch is "someone changed a panel", which touches nothing under tests/.
// `scripts/prepush-changed-tests.sh` only runs a test file when that test file
// is itself in the changed set, so a test-only guard would first surface in CI
// after the PR is already open. Wired into .husky/pre-push on `src/` exactly
// like `lint:safe-html`, it fires on the edit that matters.
//
// The guard is scoped to Panel subclasses (transitively). Classes with their
// own unrelated `content` field — `CountryDeepDivePanel`, `RouteExplorer`,
// `VirtualList` — have no Panel error state to latch and are correctly out of
// scope. `Panel` itself is exempted BY NAME below, not by the incidental fact
// that `class Panel` currently has no `extends` clause.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/main-module.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

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
 * `kind` drives the advice in the failure message, because the two categories
 * need different fixes:
 *   - `replace` — the whole subtree is being swapped. `setContentNodes` /
 *     `setTrustedContent` are drop-in replacements.
 *   - `positional` — a node is added at a specific position, or removed, while
 *     the rest of the content must survive. The sanctioned helpers WIPE, so
 *     telling these call sites to "render through setContentNodes" would be
 *     wrong: `SupplyChainPanel.prepend` runs under a live MutationObserver
 *     watching the charts it would destroy, and `ProgressChartsPanel` inserts
 *     per-chart while preserving a trailing tooltip. These need a structural
 *     change, not a substitution.
 *
 * `insertAdjacentElement('beforebegin', …)` is tracked as `positional` for
 * inventory completeness, but note it inserts a SIBLING of `this.content`, not
 * a child — it cannot latch the chip on its own.
 *
 * `probe` is the fixture the self-test matches each pattern against, so a
 * pattern that silently stops matching fails loudly instead of going quiet.
 * The receiver tolerates `?.` and `!.`: `this.content?.appendChild(row)` is a
 * live idiom in `EnergyCrisisPanel`, and a bare-dot-only pattern would miss it.
 */
export const DIRECT_WRITE_PATTERNS = [
  { label: 'replaceChildren(this.content, …)', kind: 'replace', re: /\breplaceChildren\(\s*this\.content[!]?\b/, probe: 'replaceChildren(this.content, row);' },
  { label: 'setTrustedHtml(this.content, …)', kind: 'replace', re: /\bsetTrustedHtml\(\s*this\.content[!]?\b/, probe: 'setTrustedHtml(this.content, html);' },
  { label: 'clearChildren(this.content)', kind: 'replace', re: /\bclearChildren\(\s*this\.content[!]?\b/, probe: 'clearChildren(this.content);' },
  { label: 'this.content.replaceChildren(…)', kind: 'replace', re: /\bthis\.content[!?]?\.replaceChildren\(/, probe: 'this.content.replaceChildren(row);' },
  { label: 'this.content.innerHTML = …', kind: 'replace', re: /\bthis\.content[!?]?\.innerHTML\s*=/, probe: 'this.content.innerHTML = html;' },
  { label: 'this.content.textContent = …', kind: 'replace', re: /\bthis\.content[!?]?\.textContent\s*=/, probe: 'this.content.textContent = text;' },
  { label: 'this.content.insertAdjacentHTML(…)', kind: 'positional', re: /\bthis\.content[!?]?\.insertAdjacentHTML\(/, probe: "this.content.insertAdjacentHTML('beforeend', html);" },
  { label: 'this.content.append(…)', kind: 'positional', re: /\bthis\.content[!?]?\.append\(/, probe: 'this.content.append(row);' },
  { label: 'this.content.appendChild(…)', kind: 'positional', re: /\bthis\.content[!?]?\.appendChild\(/, probe: 'this.content.appendChild(row);' },
  { label: 'this.content.prepend(…)', kind: 'positional', re: /\bthis\.content[!?]?\.prepend\(/, probe: 'this.content.prepend(banner);' },
  { label: 'this.content.insertBefore(…)', kind: 'positional', re: /\bthis\.content[!?]?\.insertBefore\(/, probe: 'this.content.insertBefore(node, ref);' },
  { label: 'this.content.insertAdjacentElement(…)', kind: 'positional', re: /\bthis\.content[!?]?\.insertAdjacentElement\(/, probe: "this.content.insertAdjacentElement('beforebegin', el);" },
  { label: 'this.content.removeChild(…)', kind: 'positional', re: /\bthis\.content[!?]?\.removeChild\(/, probe: 'this.content.removeChild(row);' },
];

/**
 * Every `<file> :: <idiom> xN` triple in the pre-#6557 legacy population.
 *
 * Recorded with an OCCURRENCE COUNT, not as a per-file or per-(file, idiom)
 * boolean. A boolean pair cannot see a SECOND write of an idiom the file
 * already carries, so adding a fresh `setTrustedHtml(this.content, …)` to
 * `AirlineIntelPanel` — which already had 15 — passed the guard green. That is
 * the highest-traffic regression shape there is, because new render code lands
 * in files that already have the legacy pattern. With counts, a new write bumps
 * N and fails `unlisted`; a migration lowers N and fails `stale`.
 *
 * This list is a ratchet, not a permission slip:
 *   - a NEW pair, or a HIGHER count, fails the guard — route the render through
 *     `setContentNodes` / `setTrustedContent` / `setSafeContent` instead;
 *   - a pair that shrank or vanished MUST be updated here, so the inventory can
 *     never quietly outlive the drift it records.
 *
 * Counts are measured on COMMENT-STRIPPED source. `ChatAnalystPanel` has one
 * real `replaceChildren(this.content, …)` call and one mention of the same
 * idiom inside a comment; scanning raw text counted 2, which would have let the
 * entry survive migration of the only real call.
 *
 * The CLI derives and reports the current entry and call-site totals from the
 * registry below; do not duplicate those shrinking counts in this comment.
 * Every entry is a latent instance of the #6557 latch for as long as it stays.
 * The confirmed-defect subset was tracked in #6577 and closed by #6587
 * (behaviour) + #6678 (this migration).
 *
 * #6678 moved the five #6577 panels' SUCCESS writes onto the sanctioned helpers,
 * which is why three of them now read `x1` rather than `x2`: the surviving write
 * in each is the LOADING branch, which must stay off `setContentNodes` — that
 * helper clears through `clearErrorState()`, and resetting the backoff on a
 * loading paint would flatten the retry ladder to its 15s floor. Do NOT "finish"
 * those three by driving the remaining write to zero — an `x1` here is the
 * ratchet's terminal state, not an unfinished migration. All three are pinned:
 * TechEvents by `tests/dom/panel-error-latch-6577.test.mts`, ServiceStatus and
 * DefensePatents by `tests/dom/panel-content-write-6678.test.mts`.
 * `GivingPanel` left the inventory entirely and `GdeltIntelPanel` keeps only its
 * `insertAdjacentElement` sibling insert (see DIRECT_WRITE_PATTERNS).
 */
export const LEGACY_DIRECT_CONTENT_WRITES = [
  'src/components/AirlineIntelPanel.ts :: setTrustedHtml(this.content, …) x8',
  'src/components/DeductionPanel.ts :: replaceChildren(this.content, …) x1',
  'src/components/DefensePatentsPanel.ts :: replaceChildren(this.content, …) x1',
  'src/components/GdeltIntelPanel.ts :: this.content.insertAdjacentElement(…) x1',
  'src/components/GoodThingsDigestPanel.ts :: setTrustedHtml(this.content, …) x1',
  'src/components/HeroSpotlightPanel.ts :: setTrustedHtml(this.content, …) x1',
  'src/components/LatestBriefPanel.ts :: clearChildren(this.content) x1',
  'src/components/LatestBriefPanel.ts :: replaceChildren(this.content, …) x1',
  'src/components/LatestBriefPanel.ts :: this.content.appendChild(…) x1',
  'src/components/LiveNewsPanel.ts :: setTrustedHtml(this.content, …) x3',
  'src/components/LiveNewsPanel.ts :: this.content.appendChild(…) x3',
  'src/components/LiveWebcamsPanel.ts :: setTrustedHtml(this.content, …) x2',
  'src/components/LiveWebcamsPanel.ts :: this.content.appendChild(…) x3',
  'src/components/ProgressChartsPanel.ts :: replaceChildren(this.content, …) x1',
  'src/components/ProgressChartsPanel.ts :: setTrustedHtml(this.content, …) x1',
  'src/components/ProgressChartsPanel.ts :: this.content.appendChild(…) x3',
  'src/components/ProgressChartsPanel.ts :: this.content.insertBefore(…) x1',
  'src/components/RegionalIntelligenceBoard.ts :: replaceChildren(this.content, …) x1',
  'src/components/RegulationPanel.ts :: setTrustedHtml(this.content, …) x1',
  'src/components/RenewableEnergyPanel.ts :: replaceChildren(this.content, …) x1',
  'src/components/RenewableEnergyPanel.ts :: this.content.appendChild(…) x3',
  'src/components/RuntimeConfigPanel.ts :: setTrustedHtml(this.content, …) x2',
  'src/components/ServiceStatusPanel.ts :: replaceChildren(this.content, …) x1',
  'src/components/SpeciesComebackPanel.ts :: replaceChildren(this.content, …) x1',
  'src/components/SpeciesComebackPanel.ts :: this.content.appendChild(…) x2',
  'src/components/SupplyChainPanel.ts :: this.content.prepend(…) x1',
  'src/components/TechEventsPanel.ts :: replaceChildren(this.content, …) x1',
  'src/components/TelegramIntelPanel.ts :: replaceChildren(this.content, …) x3',
];

/**
 * The panels #6557 migrated. Named so a future edit cannot re-list them.
 * `cii` and `strategic-risk` are the two seen latched in production; `cascade`
 * has the identical shape — a `showError()` in `init()` and a success
 * `render()` that painted `this.content` with no clear at all.
 */
export const MIGRATED_BY_6557 = [
  'src/components/CIIPanel.ts',
  'src/components/CascadePanel.ts',
  'src/components/StrategicRiskPanel.ts',
];

/**
 * The base class defines the sanctioned write primitives, so it necessarily
 * contains the idioms the blocklist bans. Excluded BY NAME — not by the
 * incidental fact that `class Panel` has no `extends` clause today. Give
 * `Panel` any base class and `derivesFromPanel` would return true for it
 * immediately, and the guard would fail on the file defining the escape hatch
 * with advice to route `Panel.replaceContent` through `Panel.setContentNodes`.
 */
export const GUARD_EXEMPT_FILES = new Set(['src/components/Panel.ts']);

/**
 * Floor for the Panel-subclass scan, derived from the 108 files it found at
 * #6557. A renamed base class or a moved directory would otherwise silently
 * shrink the population to zero and let every assertion pass vacuously.
 */
export const MIN_PANEL_SUBCLASS_FILES = 100;

/**
 * Blank out comments while preserving offsets and line count. A mention of an
 * idiom in a comment is not a call: scanning raw text both false-fails a
 * correctly-migrated file that documents the rule, and — worse, because it is
 * silent — keeps a legacy entry "observed" after its only real call is gone,
 * so the stale check never asks anyone to delete it.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

// `(?:<[^>]*>)?` so a generic subclass (`class Foo<T> extends Panel`) is not
// silently dropped from the population.
const CLASS_DECL = /\bclass\s+([A-Za-z0-9_$]+)(?:<[^>]*>)?\s+extends\s+([A-Za-z0-9_$]+)/g;

/** Base-class name for every class declared in `source`, keyed by class name. */
export function collectClassBases(source) {
  const bases = new Map();
  for (const [, name, base] of source.matchAll(CLASS_DECL)) bases.set(name, base);
  return bases;
}

/**
 * Does `className` reach `Panel` through any number of `extends` hops?
 * `MilitaryCorrelationPanel extends CorrelationPanel extends Panel` carries the
 * same latch, so a one-hop scan would under-count the guarded population.
 */
export function derivesFromPanel(className, baseOf) {
  const seen = new Set();
  for (let cursor = className; cursor; cursor = baseOf.get(cursor)) {
    if (cursor === 'Panel') return true;
    if (seen.has(cursor)) return false; // cycle guard
    seen.add(cursor);
  }
  return false;
}

/** `<idiom> xN` for every direct-write idiom present in `code`, with counts. */
export function directWritesIn(code) {
  return DIRECT_WRITE_PATTERNS.flatMap(({ label, re }) => {
    const n = (code.match(new RegExp(re.source, 'g')) ?? []).length;
    return n === 0 ? [] : [`${label} x${n}`];
  });
}

/** Advice tailored to the idiom, because the two categories need different fixes. */
export function adviceFor(label) {
  const pattern = DIRECT_WRITE_PATTERNS.find((p) => label.startsWith(p.label));
  if (pattern?.kind === 'positional') {
    return 'positional/additive write — the sanctioned helpers REPLACE all content, so this needs a structural change, not a substitution (collect the nodes and commit them in one setContentNodes call, or call clearErrorState() explicitly if the content must survive)';
  }
  return 'render through Panel.setContentNodes() / setTrustedContent() / setSafeContent()';
}

function collectTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...collectTsFiles(abs));
    else if (abs.endsWith('.ts')) out.push(abs);
  }
  return out.sort();
}

/** Scan the tree and return everything the assertions and the CLI both need. */
export function scanRepo(root = REPO_ROOT) {
  const componentsDir = path.join(root, 'src/components');
  const allFiles = collectTsFiles(componentsDir);
  const codeByFile = new Map(
    allFiles.map((abs) => [abs, stripComments(readFileSync(abs, 'utf8'))]),
  );

  const baseOf = new Map();
  for (const code of codeByFile.values()) {
    for (const [name, base] of collectClassBases(code)) baseOf.set(name, base);
  }

  const subclassFiles = allFiles.filter(
    (abs) =>
      !GUARD_EXEMPT_FILES.has(path.relative(root, abs)) &&
      [...collectClassBases(codeByFile.get(abs) ?? '').keys()].some((name) =>
        derivesFromPanel(name, baseOf),
      ),
  );

  const observed = subclassFiles
    .flatMap((abs) =>
      directWritesIn(codeByFile.get(abs) ?? '').map(
        (label) => `${path.relative(root, abs)} :: ${label}`,
      ),
    )
    .sort();

  const allowed = new Set(LEGACY_DIRECT_CONTENT_WRITES);
  const observedSet = new Set(observed);
  const observedFiles = new Set(observed.map((pair) => pair.split(' :: ')[0]));

  return {
    subclassFiles,
    observed,
    observedFiles,
    unlisted: observed.filter((pair) => !allowed.has(pair)),
    stale: LEGACY_DIRECT_CONTENT_WRITES.filter((pair) => !observedSet.has(pair)),
    regressed: MIGRATED_BY_6557.filter((file) => observedFiles.has(file)),
    relisted: MIGRATED_BY_6557.filter((file) =>
      LEGACY_DIRECT_CONTENT_WRITES.some((pair) => pair.startsWith(`${file} ::`)),
    ),
  };
}

function main() {
  const result = scanRepo();
  const problems = [];

  if (result.subclassFiles.length < MIN_PANEL_SUBCLASS_FILES) {
    problems.push(
      `Expected >= ${MIN_PANEL_SUBCLASS_FILES} Panel subclass files (108 at #6557), found ${result.subclassFiles.length} — the scan or the base-class name has drifted.`,
    );
  }

  if (result.unlisted.length > 0) {
    problems.push(
      'These Panel subclasses mutate this.content directly, so a transient showError() latches the header Error chip over correct data (#6557):',
      ...result.unlisted.map((pair) => `  - ${pair}\n      ${adviceFor(pair.split(' :: ')[1])}`),
    );
  }

  if (result.stale.length > 0) {
    problems.push(
      'These recorded writes no longer match the tree. Update LEGACY_DIRECT_CONTENT_WRITES in scripts/enforce-panel-content-writes.mjs (lower the count, or delete the line) so the inventory keeps matching reality.',
      'FIRST, though: if the write that vanished was a LOADING branch, check it did not move to setContentNodes — that clears through clearErrorState() and flattens the retry ladder to its 15s floor. tests/dom/panel-content-write-6678.test.mts and tests/dom/panel-error-latch-6577.test.mts red if it did. Routing a loading branch through the inherited showLoading() is fine and legitimately zeroes the entry.',
      ...result.stale.map((pair) => `  - ${pair}`),
    );
  }

  if (result.regressed.length > 0) {
    problems.push(
      `${result.regressed.join(', ')} — migrated off direct writes by #6557 and must keep rendering through Panel.setContentNodes() / setTrustedContent().`,
    );
  }

  if (result.relisted.length > 0) {
    problems.push(
      `${result.relisted.join(', ')} — must not be re-added to the legacy inventory to silence the guard.`,
    );
  }

  if (problems.length > 0) {
    console.error('Panel content-write guard failed (#6557).');
    for (const line of problems) console.error(line);
    process.exitCode = 1;
    return;
  }

  const sites = LEGACY_DIRECT_CONTENT_WRITES.reduce(
    (sum, pair) => sum + Number(pair.split(' x').pop()),
    0,
  );
  console.log(
    `Panel content-write guard passed (${result.subclassFiles.length} Panel subclasses scanned; ${LEGACY_DIRECT_CONTENT_WRITES.length} legacy entries / ${sites} call sites tracked).`,
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
