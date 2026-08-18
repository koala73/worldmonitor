// C2 from #6555.
//
// `ENGLISH_CEILING` measures English-identical strings, so a wholesale
// Simplified regression in `zh-TW.json` passes every existing gate. These two
// assertions close that, and the second also closes the section-A phrasing gap.
//
// WHY NOT THE ROUND TRIP AS SPECIFIED. The issue (and my own comment on it)
// proposed flagging any value where `s2t(value) !== value`. Measured, that is
// not usable in either direction:
//
//   * False positives. Feeding already-Traditional text to a Simplified→
//     Traditional converter is not idempotent — OpenCC applies its orthodox
//     variant preferences. Over the committed catalogues it rewrites 表→錶,
//     干→幹, 峰→峯, 群→羣, 核→覈, 床→牀, 才→纔 and flags 61 correct values
//     (47 with `to: 'tw'`). 儀表板 and GPS干擾 are not Simplified residue.
//   * False negatives. `s2t('許可權') === '許可權'`. Every section-A term is
//     spelled in Traditional characters — they are Mainland *vocabulary*, not
//     Simplified script — so no character-level converter can see them.
//
// So the converter is applied to the Simplified SOURCE, which is what it is for
// and where it is well-defined, and vocabulary is checked separately against the
// decisions already recorded in the generator.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import * as OpenCC from 'opencc-js';
import { GENERATED_LOCALES, LOCALES, TRANSLATABLE_LOCALES } from '../scripts/translate-locales.mjs';

const repoPath = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const s2tw = OpenCC.Converter({ from: 'cn', to: 'tw' });

const CATALOGUES = [
  { name: 'src', simplified: 'src/locales/zh.json', traditional: 'src/locales/zh-TW.json' },
  { name: 'pro-test', simplified: 'pro-test/src/locales/zh.json', traditional: 'pro-test/src/locales/zh-TW.json' },
];

/**
 * Every test this file is supposed to register, written out.
 *
 * Most of the tests below are registered from data — one per entry in
 * CATALOGUES, one per catalogue named in EXPECTED_KEY_RULES — and a loop over
 * an empty list registers nothing at all. That is not a red build: a runner
 * reports the tests it was given, so emptying CATALOGUES deletes both copies of
 * `no value is left in Simplified` and the suite passes with fewer tests than
 * it had. `--check` does not cover the gap either, because it regenerates from
 * the same tables these tests are auditing.
 *
 * So registration goes through `test()` below, which records the name, and the
 * census at the bottom compares what was recorded against this list. Removing a
 * test is then an edit in two places rather than a deletion that leaves no
 * trace. What it cannot defend is its own deletion, or the file's — nothing
 * inside a file can.
 */
const EXPECTED_TESTS = [
  'src: no value is left in Simplified',
  'pro-test: no value is left in Simplified',
  'catches a Simplified value planted in the Traditional catalogue',
  'the generator table still holds every term enforced here',
  'every replacement is itself Traditional and settles the rule that produced it',
  'src: carries none of the rejected terms',
  'pro-test: carries none of the rejected terms',
  'the generator table still holds every rule enforced here',
  'every per-entry source term has a decided allow-list',
  'src: every per-entry override is applied',
  'pro-test: every per-entry override is applied',
  'keeps generated locales inside LOCALES',
  'runs --check in the unit job, with nothing in front of it',
  'the npm scripts invoke the same generator CI does',
  'runs the unit job at all when a catalogue input changes',
  'requires the unit job before deploying',
];

const registered: string[] = [];

/** `it`, plus the census entry that makes its absence visible. */
const test = (name: string, fn: () => void): void => {
  registered.push(name);
  it(name, fn);
};

/**
 * The rejected terms, written out here and not only read from the generator.
 *
 * Everything else that could notice a term coming back is downstream of
 * `PHRASE_OVERRIDES`: `--check` regenerates the catalogues from that table, and
 * `readBannedTerms()` reads the same table. Delete a rule and the catalogue,
 * the check and the sweep all agree the term is fine now. This literal is the
 * copy the generator does not get a vote on — the sweep below runs off it, so
 * it keeps working even if the parser stops finding anything, and the deepEqual
 * makes dropping a rule a deliberate edit in two files instead of one.
 */
const EXPECTED_BANNED = [
  '實時',
  '攝像頭',
  '賬戶',
  '自定義',
  '小部件',
  '小元件',
  '許可權',
  '高階',
  '訪問',
  '曆史',
  '髮生',
  '隻基金',
];

/** Flatten to dotted paths, descending into arrays — the plan-feature bullets live there. */
function flatten(node: unknown, path = '', out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(node)) {
    node.forEach((value, index) => flatten(value, `${path}[${index}]`, out));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, path ? `${path}.${key}` : key, out);
    }
  } else if (typeof node === 'string') {
    out.set(path, node);
  }
  return out;
}

const load = (rel: string): Map<string, string> =>
  flatten(JSON.parse(readFileSync(repoPath(rel), 'utf8')));

/**
 * The same rules read back out of the generator, so the literal above and the
 * table that actually runs cannot drift apart. Same technique
 * `scripts/docs-stats.mjs` uses to read SUPPORTED_LANGUAGES out of i18n.ts.
 *
 * Both sides are returned, not just the banned one. EXPECTED_BANNED pins what a
 * rule rejects; nothing pinned what it produces, so a rule could be pointed at a
 * Simplified replacement — `"訪問": "访问"` — and the term it is named for would
 * still be absent from the catalogue. The suite would agree the vocabulary was
 * settled while the generator wrote the opposite of the decision.
 *
 * The trailing comma is optional in Python, so it is optional here too — a last
 * entry written without one used to parse as absent, which is the failure this
 * function must not have.
 */
function readPhraseRules(): { from: string; to: string }[] {
  const source = readFileSync(repoPath('scripts/convert-zh-tw.py'), 'utf8');
  const block = source.match(/^PHRASE_OVERRIDES = \{$([\s\S]*?)^\}$/m);
  assert.ok(block, 'could not find PHRASE_OVERRIDES in scripts/convert-zh-tw.py');
  return [...block[1]!.matchAll(/^\s*"([^"]+)": "([^"]+)",?$/gm)].map((m) => ({
    from: m[1]!,
    to: m[2]!,
  }));
}

interface KeyRule {
  catalogue: string;
  path: string;
  from: string;
  to: string;
}

/** The per-entry rules, written out for the same reason as EXPECTED_BANNED. */
const EXPECTED_KEY_RULES: KeyRule[] = [
  {
    catalogue: 'src',
    path: 'modals.settingsWindow.worldMonitor.register.description',
    from: '請訪問',
    to: '請造訪',
  },
  { catalogue: 'src', path: 'popups.techEvent.days.inDays', from: '天后', to: '天後' },
  { catalogue: 'pro-test', path: 'faq.q5', from: '這隻', to: '這只' },
];

/**
 * Dotted paths where a KEY_OVERRIDES source term is the right answer rather than
 * residue, per term. 天后 is a deity and a diva, 這隻 is correct before an
 * animal — that ambiguity is why those rules are per-entry rather than global.
 *
 * The lists are nonetheless empty, because neither sense occurs in either
 * catalogue: the terms are banned everywhere until one does. Scoping the guard
 * to the three entries the rules name instead leaves every other entry open —
 * a new key holding "3天后" converts to 天后 and the suite stays green — and
 * scoping it to the sense the entry has is not something a substring can do.
 * A future entry that legitimately needs one of these adds its path here.
 */
const KEY_OVERRIDE_ALLOWED_PATHS = new Map<string, readonly string[]>([
  ['請訪問', []],
  ['天后', []],
  ['這隻', []],
]);

/** Field by field, so reordering the Python table is not a failure. */
const byField = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sortRules = (rules: readonly KeyRule[]): KeyRule[] =>
  [...rules].sort(
    (a, b) =>
      byField(a.catalogue, b.catalogue) || byField(a.path, b.path) || byField(a.from, b.from),
  );

/**
 * The same rules read back out of the generator. Trailing comma optional, as
 * above.
 */
function readKeyOverrides(): KeyRule[] {
  const source = readFileSync(repoPath('scripts/convert-zh-tw.py'), 'utf8');
  const block = source.match(/^KEY_OVERRIDES = \{$([\s\S]*?)^\}$/m);
  assert.ok(block, 'could not find KEY_OVERRIDES in scripts/convert-zh-tw.py');

  const rules: KeyRule[] = [];
  let catalogue = '';
  let path = '';

  // Split on both endings: the file is LF in the repo but arrives CRLF on a
  // Windows checkout, and a trailing \r would silently match nothing below.
  for (const line of block[1]!.split(/\r?\n/)) {
    const catalogueLine = line.match(/^ {4}"([^"]+)": \{$/);
    if (catalogueLine) {
      catalogue = catalogueLine[1]!;
      path = '';
      continue;
    }
    const entryLine = line.match(/^ {8}"([^"]+)": \{$/);
    if (entryLine) {
      path = entryLine[1]!;
      continue;
    }
    const ruleLine = line.match(/^ {12}"([^"]+)": "([^"]+)",?$/);
    if (ruleLine) {
      assert.ok(catalogue && path, `rule outside a catalogue/entry: ${line}`);
      rules.push({ catalogue, path, from: ruleLine[1]!, to: ruleLine[2]! });
    }
  }

  return rules;
}

describe('zh-TW catalogues — Simplified script drift', () => {
  // The guard is only meaningful over values whose Simplified source actually
  // changes under conversion. Values that are identical in both scripts (地震,
  // 港口, 首都) legitimately match and are skipped rather than whitelisted.
  for (const catalogue of CATALOGUES) {
    test(`${catalogue.name}: no value is left in Simplified`, () => {
      const simplified = load(catalogue.simplified);
      const traditional = load(catalogue.traditional);

      const mustDiffer: string[] = [];
      const unconverted: string[] = [];

      for (const [key, source] of simplified) {
        const target = traditional.get(key);
        if (target === undefined) continue;
        if (s2tw(source) === source) continue;
        mustDiffer.push(key);
        if (target === source) unconverted.push(key);
      }

      // Without this the assertion below would pass vacuously if the catalogues
      // ever failed to load or the key paths stopped lining up.
      assert.ok(
        mustDiffer.length > 400,
        `expected hundreds of script-sensitive values, found ${mustDiffer.length}`,
      );
      assert.deepEqual(
        unconverted,
        [],
        `${unconverted.length} value(s) still carry the Simplified source verbatim`,
      );
    });
  }

  test('catches a Simplified value planted in the Traditional catalogue', () => {
    // Proves the rule above has teeth, without mutating a committed file.
    const planted = '实时更新已就绪';
    assert.notEqual(s2tw(planted), planted, 'fixture must be script-sensitive');
  });
});

describe('zh-TW catalogues — settled vocabulary', () => {
  test('the generator table still holds every term enforced here', () => {
    // Not a floor on the count: a floor of 8 over 12 terms lets 4 go silently,
    // and a parse that finds nothing at all has to fail rather than pass empty.
    assert.deepEqual(
      readPhraseRules()
        .map((rule) => rule.from)
        .sort(),
      [...EXPECTED_BANNED].sort(),
      'PHRASE_OVERRIDES and EXPECTED_BANNED disagree — a rule was dropped, renamed, or written in a form the parser misses',
    );
  });

  test('every replacement is itself Traditional and settles the rule that produced it', () => {
    // The replacement side has no hardcoded copy — writing one would just move
    // the decision, since a wrong replacement written in both places still
    // ships. These are the two properties a replacement has to have whatever it
    // says, so they hold without anyone restating the table.
    const rules = [
      ...readPhraseRules().map((rule) => ({ where: 'PHRASE_OVERRIDES', ...rule })),
      ...readKeyOverrides().map((rule) => ({
        where: `KEY_OVERRIDES ${rule.catalogue}/${rule.path}`,
        from: rule.from,
        to: rule.to,
      })),
    ];
    assert.ok(rules.length > 12, `parsed ${rules.length} rule(s), so this is checking almost nothing`);

    const failures: string[] = [];
    for (const rule of rules) {
      // Simplified on the replacement side. `"訪問": "访问"` passes every other
      // gate in this file: the banned term does leave the catalogue.
      if (s2tw(rule.to) !== rule.to) {
        failures.push(`${rule.where}: "${rule.from}" → "${rule.to}" is not Traditional`);
      }
      // A replacement that still contains a banned term is a rule that did not
      // finish, and for KEY_OVERRIDES it is also the pre-emption failing: the
      // per-entry rule runs first precisely so the global rule finds nothing
      // left to match.
      const unresolved = EXPECTED_BANNED.filter((term) => rule.to.includes(term));
      if (unresolved.length > 0) {
        failures.push(`${rule.where}: "${rule.to}" still contains ${unresolved.join(', ')}`);
      }
      if (rule.from === rule.to) failures.push(`${rule.where}: "${rule.from}" replaces itself`);
    }

    assert.deepEqual(failures, []);
  });

  for (const catalogue of CATALOGUES) {
    test(`${catalogue.name}: carries none of the rejected terms`, () => {
      const traditional = load(catalogue.traditional);
      const hits: string[] = [];

      for (const [key, value] of traditional) {
        for (const term of EXPECTED_BANNED) {
          if (value.includes(term)) hits.push(`${key}: ${term}`);
        }
        for (const [term, allowedPaths] of KEY_OVERRIDE_ALLOWED_PATHS) {
          if (value.includes(term) && !allowedPaths.includes(key)) hits.push(`${key}: ${term}`);
        }
      }

      assert.deepEqual(hits, [], `rejected terms found; rerun scripts/convert-zh-tw.py`);
    });
  }
});

describe('zh-TW catalogues — per-entry overrides', () => {
  test('the generator table still holds every rule enforced here', () => {
    assert.deepEqual(
      sortRules(readKeyOverrides()),
      sortRules(EXPECTED_KEY_RULES),
      'KEY_OVERRIDES and EXPECTED_KEY_RULES disagree — a rule was dropped, renamed, or written in a form the parser misses',
    );
  });

  test('every per-entry source term has a decided allow-list', () => {
    // Without this a rule could be added to both tables above and still reach
    // no catalogue-wide ban, which is the gap the per-entry checks leave open.
    assert.deepEqual(
      [...KEY_OVERRIDE_ALLOWED_PATHS.keys()].sort(),
      [...new Set(EXPECTED_KEY_RULES.map((rule) => rule.from))].sort(),
      'each per-entry source term needs an entry in KEY_OVERRIDE_ALLOWED_PATHS, empty if no path is exempt',
    );
  });

  for (const catalogue of CATALOGUES) {
    // Scoped off the literal, not the parse, so a parser that finds nothing
    // registers a failing test rather than no test.
    const scoped = EXPECTED_KEY_RULES.filter((rule) => rule.catalogue === catalogue.name);

    test(`${catalogue.name}: every per-entry override is applied`, () => {
      // Registered whether or not there are rules to check. Skipping
      // registration on an empty list is how the last rule for a catalogue
      // stops being enforced without anything going red, and an empty loop
      // below would report no failures for the same reason.
      assert.ok(
        scoped.length > 0,
        `no per-entry rule is declared for ${catalogue.name}; if that is intended, drop it from EXPECTED_TESTS too`,
      );

      const traditional = load(catalogue.traditional);
      const failures: string[] = [];

      for (const rule of scoped) {
        const value = traditional.get(rule.path);
        // A rule whose entry no longer exists is a rule nobody is enforcing.
        if (value === undefined) {
          failures.push(`${rule.path}: entry is gone, so "${rule.from}" is unguarded`);
          continue;
        }
        if (value.includes(rule.from)) failures.push(`${rule.path}: still carries "${rule.from}"`);
        // Checked positively too: absence of the source term is also what a
        // rewritten or deleted string looks like.
        if (!value.includes(rule.to)) failures.push(`${rule.path}: missing "${rule.to}"`);
      }

      assert.deepEqual(failures, [], `rerun scripts/convert-zh-tw.py`);
    });
  }
});

// A generated catalogue is not translated from en.json, so the EN baseline in
// translate-locales.mjs cannot say whether it is current — an English edit marks
// it stale against a comparison it was never in scope for, and no rerun of that
// script can clear it now that the write path skips it. The script reports those
// separately for exactly that reason, which leaves `--check` as the only thing
// that fails when zh.json moves and nobody reran the generator. These assertions
// exist because that check is one deleted workflow line away from being silent,
// and everything else about the catalogue would stay green.
describe('zh-TW catalogues — the generator is the freshness gate', () => {
  interface WorkflowStep {
    id?: string;
    name?: string;
    run?: string;
    if?: string;
    'continue-on-error'?: unknown;
  }
  interface WorkflowJob {
    if?: string;
    'continue-on-error'?: unknown;
    steps?: WorkflowStep[];
  }

  const workflow = loadYaml(readFileSync(repoPath('.github/workflows/test.yml'), 'utf8')) as {
    jobs: Record<string, WorkflowJob | undefined>;
  };
  const unit = workflow.jobs.unit;
  const stepsOf = (job: WorkflowJob | undefined): WorkflowStep[] => job?.steps ?? [];
  const checkCommand = 'python3 scripts/convert-zh-tw.py --check';

  test('keeps generated locales inside LOCALES', () => {
    assert.ok(GENERATED_LOCALES.size > 0, 'GENERATED_LOCALES is empty, so nothing below is checking anything');
    for (const locale of GENERATED_LOCALES) {
      // Dropping it from LOCALES would also drop it from the freshness gate and
      // the end-of-run scan, which is what `tracks every shipped locale` in
      // tests/pro-locale-freshness.test.mjs already refuses.
      assert.ok(LOCALES.includes(locale), `${locale} must stay in LOCALES; only the write path excludes it`);
      assert.ok(!TRANSLATABLE_LOCALES.includes(locale), `${locale} must not be in TRANSLATABLE_LOCALES`);
    }
  });

  test('runs --check in the unit job, with nothing in front of it', () => {
    // The previous version of this test searched the file for the string
    // `convert-zh-tw.py --check` inside the unit job's text. Presence is the
    // weakest of the three things that have to be true: a step can be present
    // and conditional, present and `continue-on-error`, or present with the
    // command edited into something that always succeeds. The workflow is
    // parsed rather than pattern-matched so those are readable properties
    // instead of substrings that happen to be nearby.
    assert.ok(unit, 'no unit job in .github/workflows/test.yml');
    const steps = stepsOf(unit).filter((step) => (step.run ?? '').includes('convert-zh-tw.py'));
    assert.equal(steps.length, 1, `expected exactly one step running the generator, found ${steps.length}`);
    const step = steps[0]!;

    // An explicit `false` is the same as absent; anything else — `true`, or an
    // expression that resolves at run time — is not something this can read.
    const blocks = (value: unknown): boolean => value === undefined || value === false;
    assert.equal(step.if, undefined, 'the step is conditional, so it can decline to run and stay green');
    assert.ok(blocks(step['continue-on-error']), 'the step is allowed to fail, so it reports without blocking');
    assert.ok(blocks(unit['continue-on-error']), 'the unit job is allowed to fail, so nothing in it blocks');

    // The body, line for line. `|| true`, a dropped `--check`, a dropped
    // version pin and an inserted `pip install --upgrade` all land here.
    assert.deepEqual(
      (step.run ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      ['pip install opencc-python-reimplemented==0.1.7', checkCommand],
      'the step no longer runs exactly the pinned install and the check',
    );
  });

  test('the npm scripts invoke the same generator CI does', () => {
    // Two ways to run one thing is two things to keep true. The scripts exist
    // so a contributor has the same command CI has; asserting they are the same
    // string is what keeps that claim from decaying into a second, older
    // invocation that disagrees about the flag or the file.
    const pkg = JSON.parse(readFileSync(repoPath('package.json'), 'utf8')) as {
      scripts: Record<string, string | undefined>;
    };
    assert.equal(pkg.scripts['locales:zh-tw'], 'python3 scripts/convert-zh-tw.py');
    assert.equal(pkg.scripts['locales:zh-tw:check'], checkCommand);
  });

  test('runs the unit job at all when a catalogue input changes', () => {
    // The third leg, and the one presence-plus-gate-membership misses entirely.
    // deploy-gate.yml reads a skipped required job as passing (docs-only PRs
    // skip the code checks by design), so `unit` being required is worth
    // exactly what the condition on `unit` is worth: if a PR touching the
    // catalogues sets code=false, the job skips, the gate counts a pass, and
    // the staleness check never ran.
    assert.ok(unit, 'no unit job in .github/workflows/test.yml');
    assert.equal(
      unit.if,
      "needs.changes.outputs.code == 'true'",
      'the unit job runs on a different condition now, and the filter read below is no longer the one that decides',
    );

    const diff = stepsOf(workflow.jobs.changes).find((step) => step.id === 'diff');
    assert.ok(diff?.run, 'could not find the diff step of the changes job');
    const program = diff.run.match(/CODE=\$\(echo "\$FILES" \| awk '([\s\S]*?)'\)/);
    assert.ok(program, 'could not read the CODE filter out of the changes job');
    const body = program[1]!;

    // The filter is an exclusion list: an unmatched path falls through to a
    // bare `{ count++ }` and sets code=true. Everything below reasons from
    // that, so it is asserted rather than assumed.
    assert.match(
      body,
      /^\s*\{ count\+\+ \}\s*$/m,
      'the CODE filter no longer counts unmatched paths, so it is not an exclusion list and this test cannot read it',
    );

    // Only rules whose whole action is `next` exclude; `{ count++; next }` is a
    // carve-back that counts. A compound rule contributes its leading pattern
    // only, which matches a superset of what awk excludes — proving a path is
    // outside the superset proves it is outside the real exclusion set.
    const exclusions = body
      .split(/\r?\n/)
      .filter((line) => /\{\s*next\s*\}\s*$/.test(line))
      .map((line) => line.match(/\/((?:[^/\\]|\\.)+)\//))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => new RegExp(match[1]!));

    assert.ok(exclusions.length >= 5, `parsed ${exclusions.length} exclusion rule(s), so the parse is broken`);
    assert.ok(
      exclusions.some((pattern) => pattern.test('README.md')),
      'the parsed rules exclude nothing at all, so the assertion below would pass on any input',
    );

    // Everything the generator reads or is defined by. A PR that only touches
    // these has to reach the unit job.
    const inputs = [
      'src/locales/zh.json',
      'src/locales/zh-TW.json',
      'pro-test/src/locales/zh.json',
      'pro-test/src/locales/zh-TW.json',
      'scripts/convert-zh-tw.py',
      'tests/i18n-zh-tw-catalogue.test.mts',
    ];
    assert.deepEqual(
      inputs.filter((path) => exclusions.some((pattern) => pattern.test(path))),
      [],
      'a PR touching only these paths sets code=false, so unit skips and the deploy gate counts the skip as a pass',
    );
  });

  test('requires the unit job before deploying', () => {
    const gate = readFileSync(repoPath('.github/workflows/deploy-gate.yml'), 'utf8');
    const required = gate.match(/required='(\[[^']*\])'/);
    assert.ok(required, 'could not read the required-job list from deploy-gate.yml');
    assert.ok(
      (JSON.parse(required[1]!) as string[]).includes('unit'),
      'the unit job is no longer gate-required, so the catalogue check stopped blocking merges',
    );
  });
});

describe('zh-TW catalogues — the tests above are all still here', () => {
  it('registers every test it is supposed to', () => {
    // Runs after the whole file has been evaluated, so `registered` is complete
    // by now regardless of where this sits.
    assert.deepEqual(
      [...registered].sort(),
      [...EXPECTED_TESTS].sort(),
      'the set of registered tests changed — a data-driven loop registered nothing, or a test was added or removed without updating EXPECTED_TESTS',
    );
  });
});
