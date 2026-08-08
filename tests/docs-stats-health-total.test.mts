/**
 * The /api/health `summary.total` doc gate (#6300).
 *
 * Four published example bodies (two English pages, two zh mirrors) quoted
 * `"total": 194` while production reported 256. Nothing pinned the figure, so
 * it was copied forward until three agreeing sources read as corroboration.
 *
 * `parseHealthProbedKeys` derives the number from api/health.js source text —
 * the docs-stats CI job runs on bare Node with no `npm install`, and the
 * runtime size depends on process.env.IRAN_EVENTS_ENABLED, so it must not be
 * imported. That makes the parser itself the thing that can silently drift, so
 * these tests do two jobs:
 *
 *   1. Pin the text parse against the REAL module's runtime registry. A text
 *      parser that agrees with itself proves nothing; one that agrees with the
 *      object health.js actually walks proves the published number.
 *   2. Drive every failure branch with synthetic fixtures, so "the gate would
 *      have caught it" is executed rather than asserted.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  parseHealthProbedKeys,
  parseProbedRegistries,
  validateHealthSummaryDocs,
  healthSummaryDocSources,
  computeStats,
  DOC_VALIDATORS,
  HEALTH_SUMMARY_DOC_FILES,
} from '../scripts/docs-stats.mjs';
import { __testing__ as healthTesting } from '../api/health.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const REAL_SOURCE = read('api/health.js');

const DOC_PAGES = [
  'docs/health-endpoints.mdx',
  'docs/api-platform.mdx',
  'docs/zh/health-endpoints.mdx',
  'docs/zh/api-platform.mdx',
];

/**
 * Mutate the real api/health.js text. Throws when the anchor it targets is
 * gone: a fixture that silently stops mutating anything turns every "this
 * drift is caught" assertion below into a test of nothing.
 */
function mutate(from: string | RegExp, to: string): string {
  const occurrences = typeof from === 'string'
    ? REAL_SOURCE.split(from).length - 1
    : [...REAL_SOURCE.matchAll(new RegExp(from, 'g'))].length;
  assert.equal(occurrences, 1, `fixture drift: api/health.js must contain exactly one \`${from}\``);
  return REAL_SOURCE.replace(from, to);
}

const REAL_STATS = computeStats();
const REAL_TOTAL: number = REAL_STATS.healthProbedKeys.total;

/** A synthetic docs page carrying one /api/health summary example. */
function docWithSummary(fields: Record<string, number>): string {
  const full = {
    total: 0, ok: 0, warn: 0, onDemandWarn: 0, staleContent: 0, rolloutPending: 0, crit: 0, ...fields,
  };
  const body = Object.entries(full).map(([k, v]) => `    "${k}": ${v}`).join(',\n');
  return `\n\`\`\`json\n{\n  "summary": {\n${body}\n  }\n}\n\`\`\`\n`;
}

describe('/api/health probed-key count doc gate (#6300)', () => {
  it('derives the same total the runtime registry actually walks', () => {
    // api/health.js counts one check per BOOTSTRAP_KEYS + STANDALONE_KEYS entry
    // (the `sources` loop that increments totalChecks). Importing it here is
    // safe — only the always-on docs-stats CI job runs without node_modules.
    const runtimeBootstrap = Object.keys(healthTesting.BOOTSTRAP_KEYS).length;
    const runtimeStandalone = Object.keys(healthTesting.STANDALONE_KEYS).length;

    const parsed = parseHealthProbedKeys(REAL_SOURCE);

    assert.equal(parsed.bootstrap, runtimeBootstrap);
    assert.equal(parsed.standalone, runtimeStandalone);
    assert.equal(parsed.total, runtimeBootstrap + runtimeStandalone);

    // Counts alone would let a compensating pair cancel out — one real key the
    // identifier matcher misses plus one phantom it invents net to the same
    // number. Compare the key SETS, which cannot.
    assert.deepEqual(
      parsed.bootstrapKeys.slice().sort(),
      Object.keys(healthTesting.BOOTSTRAP_KEYS).sort(),
    );
    assert.deepEqual(
      parsed.standaloneKeys.slice().sort(),
      Object.keys(healthTesting.STANDALONE_KEYS).sort(),
    );
  });

  it('reads the same registries the endpoint actually probes', () => {
    // The count above is only summary.total because these are the registries
    // the `sources` loop walks. A third one added there is the single edit that
    // reproduces #6300 exactly: production grows, every gate stays pinned.
    assert.deepEqual(
      parseProbedRegistries(REAL_SOURCE).sort(),
      ['BOOTSTRAP_KEYS', 'STANDALONE_KEYS'],
    );
  });

  it('fails when a third registry joins the endpoint\'s probe list', () => {
    const source = mutate(
      '    [STANDALONE_KEYS, { allowOnDemand: true }],\n',
      '    [STANDALONE_KEYS, { allowOnDemand: true }],\n    [OPS_KEYS, { allowOnDemand: true }],\n',
    );
    assert.throws(() => parseHealthProbedKeys(source), /probes a different set of key registries/);
  });

  it('fails when the endpoint stops counting every registry entry', () => {
    // summary.total equals the registry size only while totalChecks++ is
    // unconditional. A `continue` ahead of it shrinks production's total while
    // both the parse and the Object.keys() cross-check above stay put.
    const source = mutate(
      '    for (const [name, redisKey] of Object.entries(registry)) {\n      totalChecks++;',
      '    for (const [name, redisKey] of Object.entries(registry)) {\n      if (!shouldProbe(name)) continue;\n      totalChecks++;',
    );
    assert.throws(() => parseHealthProbedKeys(source), /no longer counts every registry entry unconditionally/);
  });

  it('discovers every publishing page, including the zh mirrors, and passes on them', () => {
    const discovered = healthSummaryDocSources();
    assert.deepEqual(discovered.failures, []);
    // Discovered, not listed — the floor is a floor, not the scope. Two of the
    // four are zh mirrors, which #6300 shows is exactly what a hand-maintained
    // list forgets.
    for (const page of HEALTH_SUMMARY_DOC_FILES) assert.ok(discovered.docs[page], `${page} not discovered`);
    assert.deepEqual(Object.keys(discovered.docs).sort(), [...DOC_PAGES].sort());
    assert.deepEqual(validateHealthSummaryDocs(REAL_STATS), []);
  });

  it('is wired into the always-on gate, not just registered', () => {
    // A validator dropped from DOC_VALIDATORS stops running while every test
    // that calls it directly stays green. This is the always-on job's only
    // pin on these four pages, so the wiring is the thing to assert.
    assert.ok(
      DOC_VALIDATORS.includes(validateHealthSummaryDocs),
      'validateHealthSummaryDocs must run in the --check validator set',
    );
  });

  it('catches a stale total on any page', () => {
    const failures = validateHealthSummaryDocs(REAL_STATS, {
      'docs/health-endpoints.mdx': docWithSummary({ total: 194, ok: 194 }),
    });
    assert.ok(failures.some((f) => /summary\.total is 194/.test(f)), failures.join(' | '));
  });

  it('catches a SECOND, stale example block below the current one', () => {
    // The hole a `claims()` entry could not close: `text.match()` reads only the
    // first match, so an appended stale body would publish an unpinned number —
    // and on a docs-only PR the `unit` job is skipped, leaving this validator as
    // the only gate that runs at all.
    const page = docWithSummary({ total: REAL_TOTAL, ok: REAL_TOTAL })
      + docWithSummary({ total: 194, ok: 194 });
    const failures = validateHealthSummaryDocs(REAL_STATS, { 'docs/health-endpoints.mdx': page });
    assert.ok(
      failures.some((f) => /summary example 2 of 2/.test(f) && /is 194/.test(f)),
      failures.join(' | '),
    );
  });

  it('catches a body whose buckets do not partition total', () => {
    // The pre-#6300 api-platform.mdx body: a concrete "HEALTHY" alongside 5
    // warns and 9 onDemandWarns. Checking the partition rather than demanding
    // an all-OK shape leaves a page free to illustrate a WARNING fleet.
    const failures = validateHealthSummaryDocs(REAL_STATS, {
      'docs/health-endpoints.mdx': docWithSummary({ total: REAL_TOTAL, ok: REAL_TOTAL, warn: 5 }),
    });
    assert.ok(failures.some((f) => /must equal total/.test(f)), failures.join(' | '));

    // ...and a truthful WARNING example still passes.
    assert.deepEqual(
      validateHealthSummaryDocs(REAL_STATS, {
        'docs/health-endpoints.mdx': docWithSummary({ total: REAL_TOTAL, ok: REAL_TOTAL - 13, warn: 13 }),
      }),
      [],
    );
  });

  it('catches a subset counter exceeding the warn bucket it is a subset of', () => {
    const failures = validateHealthSummaryDocs(REAL_STATS, {
      'docs/health-endpoints.mdx': docWithSummary({ total: REAL_TOTAL, ok: REAL_TOTAL - 2, warn: 2, staleContent: 5 }),
    });
    assert.ok(failures.some((f) => /staleContent \(5\) is documented as a subset/.test(f)), failures.join(' | '));
  });

  it('fails when a known page silently drops its example', () => {
    // Scope is discovered, so a page that stops carrying the anchor would just
    // fall out of it. The floor is what turns that into a failure — asserted
    // through the discovery helper, since injecting `docs` bypasses discovery.
    const discovered = healthSummaryDocSources({
      'docs/health-endpoints.mdx': docWithSummary({ total: REAL_TOTAL, ok: REAL_TOTAL }),
      'docs/api-platform.mdx': 'the summary example was deleted',
    });
    assert.deepEqual(Object.keys(discovered.docs), ['docs/health-endpoints.mdx']);
    for (const page of HEALTH_SUMMARY_DOC_FILES.filter((p: string) => p !== 'docs/health-endpoints.mdx')) {
      assert.ok(
        discovered.failures.some((f: string) => f.startsWith(`${page}:`)),
        `${page} should have failed the floor — got ${discovered.failures.join(' | ')}`,
      );
    }
  });

  it('no longer hardcodes a drifting count in prose', () => {
    // The prose figure is the half that cannot be pinned to a stat, so it must
    // state the property instead. These pages carried "currently ~194" and
    // "~194 keys with record counts" for long enough to go 62 keys stale.
    assert.doesNotMatch(read('docs/health-endpoints.mdx'), /~\s*\d+\s*(?:and growing|keys with record counts)/);
    assert.doesNotMatch(read('docs/zh/health-endpoints.mdx'), /约\s*\d+\s*个(?:，并随面板|键及记录计数)/);
  });

  it('counts a newly registered key', () => {
    const before = parseHealthProbedKeys(REAL_SOURCE).total;
    const source = mutate(
      "const STANDALONE_KEYS = {\n",
      "const STANDALONE_KEYS = {\n  brandNewPanel:      'brand:new-panel:v1',\n",
    );
    assert.equal(parseHealthProbedKeys(source).total, before + 1);
  });

  it('counts every consumer-price market the loop registers', () => {
    const before = parseHealthProbedKeys(REAL_SOURCE).total;
    const source = mutate(
      "'ae', 'au', 'br', 'gb', 'in', 'sa', 'sg', 'us'",
      "'ae', 'au', 'br', 'gb', 'in', 'sa', 'sg', 'us', 'zz'",
    );
    // The loop skips 'ae', so a ninth market is one more probed key.
    assert.equal(parseHealthProbedKeys(source).total, before + 1);
  });

  it('subtracts the iran-events sunset exactly once', () => {
    // The delete is why bootstrap is one smaller than its literal. Re-enabling
    // the key by removing the delete must give the count back, not leave the
    // subtraction stranded against a literal that still declares it.
    const source = mutate('  delete BOOTSTRAP_KEYS.iranEvents;\n', '');
    assert.throws(
      () => parseHealthProbedKeys(source),
      /no longer contains the accounted-for mutation/,
      'dropping an accounted-for mutation must fail loudly, not silently keep subtracting',
    );
  });

  it('refuses to publish a total when health.js mutates its registries in an unaccounted way', () => {
    // The whole point: a third mutation must not silently shift the published
    // number. Hardcoded arithmetic would have kept reporting the old total.
    const source = mutate(
      '  delete BOOTSTRAP_KEYS.iranEvents;\n',
      "  delete BOOTSTRAP_KEYS.iranEvents;\n  STANDALONE_KEYS.someNewThing = 'some:new:thing:v1';\n",
    );
    assert.throws(() => parseHealthProbedKeys(source), (err: Error) => {
      assert.match(err.message, /does not\s+account for/);
      assert.match(err.message, /someNewThing/);
      return true;
    });
  });

  it('does not mistake a registry READ for a mutation', () => {
    // `STANDALONE_KEYS[sibling] ?? BOOTSTRAP_KEYS[sibling]` in the cascade
    // lookup is a read, and `...Object.values(BOOTSTRAP_KEYS)` builds the
    // pipeline command list. A matcher that caught either would fail the gate
    // permanently, so the accounted-set check would get loosened to nothing.
    assert.match(REAL_SOURCE, /STANDALONE_KEYS\[sibling\] \?\? BOOTSTRAP_KEYS\[sibling\]/);
    assert.match(REAL_SOURCE, /\.\.\.Object\.values\(BOOTSTRAP_KEYS\)/);
    assert.doesNotThrow(() => parseHealthProbedKeys(REAL_SOURCE));
  });

  // Each of these registers a key at runtime. Before the mutation matcher was
  // widened, every one returned 256 unchanged instead of throwing.
  for (const [label, line] of [
    ['a compound assignment', "  STANDALONE_KEYS.lateKey ??= 'late:key:v1';\n"],
    ['Object.defineProperty', "  Object.defineProperty(STANDALONE_KEYS, 'dp', { value: 'x', enumerable: true });\n"],
    // No Object.assign on either registry today, so this alternation is the one
    // branch with no live example to keep it honest — a regex regression here
    // would surface only once someone wrote health.js in that style.
    ['Object.assign', "  Object.assign(STANDALONE_KEYS, { bulkKey: 'bulk:key:v1' });\n"],
    ['an alias binding', '  const REG = STANDALONE_KEYS;\n'],
  ] as const) {
    it(`discovers a registry write via ${label}`, () => {
      const source = mutate('  delete BOOTSTRAP_KEYS.iranEvents;\n', `  delete BOOTSTRAP_KEYS.iranEvents;\n${line}`);
      assert.throws(() => parseHealthProbedKeys(source), /does not\s+account for/);
    });
  }

  it('is not satisfied by a COMMENTED-OUT accounted mutation', () => {
    // The presence check exists to prove health.js still performs the mutation
    // the arithmetic prices. A commented-out delete normalizes to the exact
    // accounted string, so before comments were blanked it satisfied the very
    // guard whose error message is "stale arithmetic" — while the runtime
    // registry kept the key.
    const source = mutate('  delete BOOTSTRAP_KEYS.iranEvents;\n', '  // delete BOOTSTRAP_KEYS.iranEvents;\n');
    assert.throws(() => parseHealthProbedKeys(source), /no longer contains the accounted-for mutation/);
  });

  it('blanks line comments before looking for block comments', () => {
    // api/health.js carries `.../configs/retailers/*.yaml.` inside a LINE
    // comment. Blanking block comments first lets that `/*` open a comment that
    // runs 1098 lines to the next `*/`, erasing the consumer-price loop, the
    // iranEvents delete, and most of STANDALONE_KEYS.
    assert.match(REAL_SOURCE, /\/\/[^\n]*configs\/retailers\/\*\.yaml/);
    assert.equal(parseHealthProbedKeys(REAL_SOURCE).total, REAL_TOTAL);
  });

  it('rejects a brace inside a registry comment instead of silently truncating', () => {
    // parseObjectBlockBody counts raw braces, so one `}` in a comment ends the
    // block early and yields a plausible short count, not an error.
    const source = mutate(
      "  hkoWarnings:        'weather:hko-warnings:v1',\n",
      "  // closing an inline snippet } here\n  hkoWarnings:        'weather:hko-warnings:v1',\n",
    );
    assert.equal(parseHealthProbedKeys(source).total, REAL_TOTAL);
  });

  // Shapes that change Object.entries(registry) but not the identifier matcher.
  for (const [label, line] of [
    ['a quoted key', "  'quoted-key': 'quoted:key:v1',\n"],
    ['a computed key', '  [SOME_CONST]: \'computed:key:v1\',\n'],
    ['a spread', '  ...EXTRA_STANDALONE_KEYS,\n'],
    ['a deeper-indented key', "    deepKey: 'deep:key:v1',\n"],
  ] as const) {
    it(`refuses to count a registry containing ${label}`, () => {
      const source = mutate('const STANDALONE_KEYS = {\n', `const STANDALONE_KEYS = {\n${line}`);
      assert.throws(() => parseHealthProbedKeys(source), /cannot read|entry terminators/);
    });
  }

  it('refuses to count a non-conforming entry that carries no comma', () => {
    // Isolates the whole-body conformance check from the comma cross-count:
    // a trailing entry with no comma leaves the terminator count untouched, so
    // only the conformance check can see it. Without this fixture, disabling
    // that check leaves all other tests green.
    const source = mutate(
      "  intelHistoryIngestEnergyIntelligence:  'intel-history:ingest-health:energy:intelligence:v1',\n};",
      "  intelHistoryIngestEnergyIntelligence:  'intel-history:ingest-health:energy:intelligence:v1',\n  ...EXTRA_STANDALONE_KEYS\n};",
    );
    assert.throws(() => parseHealthProbedKeys(source), /cannot read/);
  });

  it('refuses to count two entries sharing one line', () => {
    const source = mutate(
      'const STANDALONE_KEYS = {\n',
      "const STANDALONE_KEYS = {\n  aKey: 'a:v1', bKey: 'b:v1',\n",
    );
    assert.throws(() => parseHealthProbedKeys(source), /entry terminators/);
  });

  it('does not double-count a market the literal already declares', () => {
    // `BOOTSTRAP_KEYS[name] = …` overwrites a same-named literal entry, so the
    // runtime count is unchanged while a naive +1-per-market would grow.
    const source = mutate(
      "  consumerPricesCoverage:   'consumer-prices:coverage:ae',\n",
      "  consumerPricesCoverage:   'consumer-prices:coverage:ae',\n  consumerPricesCoverageUS: 'consumer-prices:coverage:us',\n",
    );
    assert.throws(() => parseHealthProbedKeys(source), /already declares "consumerPricesCoverageUS"/);
  });

  it('does not double-count a repeated market', () => {
    const source = mutate(
      "'ae', 'au', 'br', 'gb', 'in', 'sa', 'sg', 'us'",
      "'ae', 'au', 'br', 'gb', 'in', 'sa', 'sg', 'us', 'us'",
    );
    assert.throws(() => parseHealthProbedKeys(source), /more than once/);
  });

  it('fails when the iran-events default flips, changing the documented registry', () => {
    const source = mutate("(process.env.IRAN_EVENTS_ENABLED ?? 'false')", "(process.env.IRAN_EVENTS_ENABLED ?? 'true')");
    assert.throws(() => parseHealthProbedKeys(source), /no longer defaults to false/);
  });

  it("fails when the consumer-price loop stops skipping 'ae'", () => {
    const source = mutate("  if (market === 'ae') continue;\n", '');
    assert.throws(() => parseHealthProbedKeys(source), /no longer skips 'ae'/);
  });

  it('fails when a registry it counts disappears', () => {
    const source = mutate('const STANDALONE_KEYS = {', 'const STANDALONE_KEYS_RENAMED = {');
    assert.throws(() => parseHealthProbedKeys(source), /could not parse STANDALONE_KEYS/);
  });

  it('fails on a duplicate registry key rather than under-counting it', () => {
    const source = mutate(
      "const STANDALONE_KEYS = {\n",
      "const STANDALONE_KEYS = {\n  hkoWarnings:      'weather:hko-warnings:v1',\n",
    );
    assert.throws(() => parseHealthProbedKeys(source), /declares "hkoWarnings" twice/);
  });
});
