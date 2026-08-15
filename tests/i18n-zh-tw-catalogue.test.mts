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
import * as OpenCC from 'opencc-js';
import { GENERATED_LOCALES, LOCALES, TRANSLATABLE_LOCALES } from '../scripts/translate-locales.mjs';

const repoPath = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const s2tw = OpenCC.Converter({ from: 'cn', to: 'tw' });

const CATALOGUES = [
  { name: 'src', simplified: 'src/locales/zh.json', traditional: 'src/locales/zh-TW.json' },
  { name: 'pro-test', simplified: 'pro-test/src/locales/zh.json', traditional: 'pro-test/src/locales/zh-TW.json' },
];

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
 * The same terms read back out of the generator, so the literal above and the
 * table that actually runs cannot drift apart. Same technique
 * `scripts/docs-stats.mjs` uses to read SUPPORTED_LANGUAGES out of i18n.ts.
 *
 * The trailing comma is optional in Python, so it is optional here too — a last
 * entry written without one used to parse as absent, which is the failure this
 * function must not have.
 */
function readBannedTerms(): string[] {
  const source = readFileSync(repoPath('scripts/convert-zh-tw.py'), 'utf8');
  const block = source.match(/^PHRASE_OVERRIDES = \{$([\s\S]*?)^\}$/m);
  assert.ok(block, 'could not find PHRASE_OVERRIDES in scripts/convert-zh-tw.py');
  return [...block[1]!.matchAll(/^\s*"([^"]+)": "[^"]+",?$/gm)].map((m) => m[1]!);
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
    it(`${catalogue.name}: no value is left in Simplified`, () => {
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

  it('catches a Simplified value planted in the Traditional catalogue', () => {
    // Proves the rule above has teeth, without mutating a committed file.
    const planted = '实时更新已就绪';
    assert.notEqual(s2tw(planted), planted, 'fixture must be script-sensitive');
  });
});

describe('zh-TW catalogues — settled vocabulary', () => {
  it('the generator table still holds every term enforced here', () => {
    // Not a floor on the count: a floor of 8 over 12 terms lets 4 go silently,
    // and a parse that finds nothing at all has to fail rather than pass empty.
    assert.deepEqual(
      readBannedTerms().sort(),
      [...EXPECTED_BANNED].sort(),
      'PHRASE_OVERRIDES and EXPECTED_BANNED disagree — a rule was dropped, renamed, or written in a form the parser misses',
    );
  });

  for (const catalogue of CATALOGUES) {
    it(`${catalogue.name}: carries none of the rejected terms`, () => {
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
  it('the generator table still holds every rule enforced here', () => {
    assert.deepEqual(
      sortRules(readKeyOverrides()),
      sortRules(EXPECTED_KEY_RULES),
      'KEY_OVERRIDES and EXPECTED_KEY_RULES disagree — a rule was dropped, renamed, or written in a form the parser misses',
    );
  });

  it('every per-entry source term has a decided allow-list', () => {
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
    if (scoped.length === 0) continue;

    it(`${catalogue.name}: every per-entry override is applied`, () => {
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
  const workflow = readFileSync(repoPath('.github/workflows/test.yml'), 'utf8').replace(/\r\n/g, '\n');

  it('keeps generated locales inside LOCALES', () => {
    assert.ok(GENERATED_LOCALES.size > 0, 'GENERATED_LOCALES is empty, so nothing below is checking anything');
    for (const locale of GENERATED_LOCALES) {
      // Dropping it from LOCALES would also drop it from the freshness gate and
      // the end-of-run scan, which is what `tracks every shipped locale` in
      // tests/pro-locale-freshness.test.mjs already refuses.
      assert.ok(LOCALES.includes(locale), `${locale} must stay in LOCALES; only the write path excludes it`);
      assert.ok(!TRANSLATABLE_LOCALES.includes(locale), `${locale} must not be in TRANSLATABLE_LOCALES`);
    }
  });

  it('runs --check inside a job the deploy gate requires', () => {
    // Presence alone is not enough: a step in a job outside the required set
    // reports red without blocking anything.
    const unitJob = workflow.match(/\n {2}unit:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/);
    assert.ok(unitJob, 'could not locate the unit job in .github/workflows/test.yml');
    assert.match(
      unitJob[1]!,
      /convert-zh-tw\.py --check/,
      'the staleness gate for the generated catalogues is not run by the unit job',
    );

    const gate = readFileSync(repoPath('.github/workflows/deploy-gate.yml'), 'utf8');
    const required = gate.match(/required='(\[[^']*\])'/);
    assert.ok(required, 'could not read the required-job list from deploy-gate.yml');
    assert.ok(
      (JSON.parse(required[1]!) as string[]).includes('unit'),
      'the unit job is no longer gate-required, so the catalogue check stopped blocking merges',
    );
  });
});
