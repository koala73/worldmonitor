#!/usr/bin/env node
// Whole-table CII diff: scores every fixture in tests/fixtures/cii/ with the
// scorer at a base git ref and with the working tree, and prints Markdown for
// a PR body. Required by docs/methodology/cii-change-brief.md for every
// change that can move a CII score.
//
//   node --import tsx scripts/cii-table-diff.mts [--base origin/main] [--write-expected]
//
// --write-expected records the working tree's output as the fixtures'
// expected table for the current CII_FORMULA_VERSION. It refuses to change a
// version's existing entry: a score change needs a new formula version.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  CII_FIXTURE_DIR,
  distinctScoreCount,
  expectedFromTable,
  floorLiftedCount,
  loadCiiFixtures,
  pairsOrderedAgainstBlend,
  scoreCiiFixture,
  spearman,
  type CiiFixture,
} from './lib/cii-fixtures.mts';
import { buildCiiAuxiliarySources } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCORER_PATH = 'server/worldmonitor/intelligence/v1/get-risk-scores.ts';
// Everything the scorer imports, transitively.
const ARCHIVE_PATHS = ['server', 'shared', 'scripts/shared', 'src/generated', 'src/config', 'src/shared', 'src/types', 'package.json', 'tsconfig.json'];

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/main' },
    'write-expected': { type: 'boolean', default: false },
  },
});

interface Row { region: string; blended: number | null; floor: number | null; bindingFloors: string[] | null; combinedScore: number }

/** The base ref's scorer, extracted to a temporary tree that shares this checkout's node_modules. */
async function loadBaseScorer(ref: string): Promise<{ module: any; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'cii-table-diff-'));
  const archive = execFileSync('git', ['archive', '--format=tar', ref, ...ARCHIVE_PATHS], { cwd: REPO_ROOT, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  const module = await import(join(dir, SCORER_PATH));
  return { module, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function scoreWithBase(base: any, fixture: CiiFixture): Row[] {
  if (typeof base.computeCiiScoreTable === 'function') {
    return base.computeCiiScoreTable(fixture.inputs, { nowMs: fixture.nowMs, iranEventsEnabled: fixture.iranEventsEnabled }).rows;
  }
  // A ref from before the scoring seam: parse with this tree's builder (the
  // same parsing the old fetchAuxiliarySources did) and score with the base
  // formula, which reports only final scores.
  const aux = buildCiiAuxiliarySources(fixture.inputs, fixture.nowMs, { iranEventsEnabled: fixture.iranEventsEnabled });
  return base.computeCIIScores([], aux, { nowMs: fixture.nowMs }).map((s: any) => ({
    region: s.region, blended: null, floor: null, bindingFloors: null, combinedScore: s.combinedScore,
  }));
}

const fmt = (n: number | null, digits = 1) => (n == null ? '–' : n.toFixed(digits));
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `${n}` : '0');

const fixtures = loadCiiFixtures();
if (!fixtures.length) throw new Error(`no fixtures in ${CII_FIXTURE_DIR}`);
const { module: base, cleanup } = await loadBaseScorer(values.base!);
const headRef = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const baseSha = execFileSync('git', ['rev-parse', '--short', values.base!], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== '';
const out: string[] = [
  `## CII whole-table diff`,
  '',
  `Base \`${values.base}\` (${baseSha}) vs head \`${headRef}\`${dirty ? ' plus uncommitted changes' : ''}, formula ${CII_FORMULA_VERSION}, ${fixtures.length} fixtures.`,
  'Blended is the score before floors, rounding and the cap. A floor binds when it exceeds the rounded blend.',
];
let writes = 0;
try {
  for (const fixture of fixtures) {
    const headRows: Row[] = scoreCiiFixture(fixture).rows;
    const baseRows = new Map(scoreWithBase(base, fixture).map((r) => [r.region, r]));
    const rows = [...headRows].sort((a, b) => b.combinedScore - a.combinedScore || a.region.localeCompare(b.region));
    out.push('', `### ${fixture.label}`, '');
    out.push('| Country | Blended base | Blended head | Binding floor | Final base | Final head | Δ final |');
    out.push('|---|---:|---:|---|---:|---:|---:|');
    for (const r of rows) {
      const b = baseRows.get(r.region);
      const binds = r.bindingFloors?.length ? `${r.bindingFloors.join(' = ')} ${r.floor}` : '–';
      const delta = r.combinedScore - (b?.combinedScore ?? Number.NaN);
      out.push(`| ${r.region} | ${fmt(b?.blended ?? null)} | ${fmt(r.blended)} | ${binds} | ${b?.combinedScore ?? '–'} | ${r.combinedScore} | ${Number.isNaN(delta) ? '–' : signed(delta)} |`);
    }
    const baseList = rows.map((r) => baseRows.get(r.region)!);
    const baseHasTerms = baseList.every((r) => r.blended != null);
    const moved = rows.filter((r) => Math.abs(r.combinedScore - (baseRows.get(r.region)?.combinedScore ?? r.combinedScore)) >= 3).length;
    const footer = (label: string, headValue: string | number, baseValue: string | number) => `| ${label} | ${baseValue} | ${headValue} |`;
    out.push('', '| Whole table | Base | Head |', '|---|---:|---:|');
    out.push(footer('Floor-lifted countries (final − blended > 5)', floorLiftedCount(rows as any), baseHasTerms ? floorLiftedCount(baseList as any) : '–'));
    out.push(footer('Distinct final scores', distinctScoreCount(rows), distinctScoreCount(baseList)));
    out.push(footer('Pairs ordered against the blend', pairsOrderedAgainstBlend(rows as any).length, baseHasTerms ? pairsOrderedAgainstBlend(baseList as any).length : '–'));
    out.push(footer('Countries moved by ≥ 3', moved, '–'));
    out.push('', `Spearman ρ of final scores, base vs head: ${spearman(baseList.map((r) => r.combinedScore), rows.map((r) => r.combinedScore)).toFixed(4)}.`);

    if (values['write-expected']) {
      const expected = expectedFromTable(scoreCiiFixture(fixture));
      const existing = fixture.expected[CII_FORMULA_VERSION];
      if (existing && JSON.stringify(existing) !== JSON.stringify(expected)) {
        throw new Error(`${fixture.label}: ${CII_FORMULA_VERSION} already has a different expected table. A score change needs a new CII_FORMULA_VERSION.`);
      }
      if (!existing) {
        fixture.expected[CII_FORMULA_VERSION] = expected;
        writeFileSync(join(CII_FIXTURE_DIR, `${fixture.label}.json`), `${JSON.stringify(fixture)}\n`);
        writes++;
      }
    }
  }
} finally {
  cleanup();
}
console.log(out.join('\n'));
if (values['write-expected']) console.error(`recorded ${CII_FORMULA_VERSION} expected tables in ${writes} fixture(s)`);
