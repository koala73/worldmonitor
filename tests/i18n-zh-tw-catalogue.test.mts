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
 * The terms the project has already ruled wrong, read from the generator so the
 * two can't drift. Same technique `scripts/docs-stats.mjs` uses to read
 * SUPPORTED_LANGUAGES out of i18n.ts.
 */
function readBannedTerms(): string[] {
  const source = readFileSync(repoPath('scripts/convert-zh-tw.py'), 'utf8');
  const block = source.match(/^PHRASE_OVERRIDES = \{$([\s\S]*?)^\}$/m);
  assert.ok(block, 'could not find PHRASE_OVERRIDES in scripts/convert-zh-tw.py');
  return [...block[1]!.matchAll(/^\s*"([^"]+)": "[^"]+",$/gm)].map((m) => m[1]!);
}

interface KeyRule {
  catalogue: string;
  path: string;
  from: string;
  to: string;
}

/**
 * The per-entry rules, read from the same generator.
 *
 * These cannot join the banned-term list above, and that is the whole reason
 * they live in KEY_OVERRIDES: their source terms are legitimate elsewhere. 天后
 * is a deity and a diva, 這隻 is correct before an animal — a catalogue-wide ban
 * would be asserting the opposite of why the entry exists. So each rule is
 * checked against the one entry it was written for.
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
    const ruleLine = line.match(/^ {12}"([^"]+)": "([^"]+)",$/);
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
  const banned = readBannedTerms();

  it('reads the term list from the generator', () => {
    // A parse failure must fail the guard, not empty it.
    assert.ok(banned.length >= 8, `parsed only ${banned.length} override terms`);
    assert.ok(banned.includes('許可權'), 'expected the #6555 terms to be present');
  });

  for (const catalogue of CATALOGUES) {
    it(`${catalogue.name}: carries none of the rejected terms`, () => {
      const traditional = load(catalogue.traditional);
      const hits: string[] = [];

      for (const [key, value] of traditional) {
        for (const term of banned) {
          if (value.includes(term)) hits.push(`${key}: ${term}`);
        }
      }

      assert.deepEqual(hits, [], `rejected terms found; rerun scripts/convert-zh-tw.py`);
    });
  }
});

describe('zh-TW catalogues — per-entry overrides', () => {
  const rules = readKeyOverrides();

  it('reads the per-entry rules from the generator', () => {
    // A parse failure must fail the guard, not empty it.
    assert.ok(rules.length >= 3, `parsed only ${rules.length} per-entry rules`);
    assert.ok(
      rules.some((rule) => rule.from === '天后'),
      'expected the character-selection fixes to be present',
    );
  });

  for (const catalogue of CATALOGUES) {
    const scoped = rules.filter((rule) => rule.catalogue === catalogue.name);
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
