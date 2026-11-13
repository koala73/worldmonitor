import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { __testing__ as health } from '../api/health.js';

// Pin the approved C0 independently so editing the first baseline cannot erase its floor.
const scored = 'US RU CN UA IR IL TW KP SA TR PL DE FR GB IN PK SY YE MM VE CU MX BR AE KR IQ AF LB EG JP QA'.split(' ');
const gaps = new Set(['KP', 'CU', 'SY', 'YE', 'MM', 'AF']);
const expected = scored.filter(code => !gaps.has(code));
const NOW = Date.UTC(2026, 10, 13);
function payload() {
  return { schemaVersion: 1, countries: Object.fromEntries(scored.map(code => [code, {
    measured: !gaps.has(code), members: gaps.has(code) ? {} : {
      inflation: { status: 'fresh', value: 0, observedAt: '2026-11-12', expiresAt: NOW + 86400000 },
    },
  }])) };
}
test('health identifies a lost expected country even when another country replaces its count', () => {
  const p = payload();
  p.countries.QA.members = {};
  p.countries.KP.members = p.countries.US.members;
  const result = health.composeCiiEconomicStressHealth({ status: 'OK' }, JSON.stringify(p), false, NOW);
  assert.equal(result.measuredCount, 25);
  assert.equal(result.status, 'COVERAGE_PARTIAL');
  assert.deepEqual(result.missingExpectedCountries, ['QA']);
});
test('expected economic gaps do not alarm', () => {
  const result = health.composeCiiEconomicStressHealth({ status: 'OK' }, JSON.stringify(payload()), false, NOW);
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.missingExpectedCountries, []);
});

type Release = { step: string; scoredCountries: string[]; families: Record<string, string[]> };
type Exception = { from: string; to: string; family: string; country: string; ruling: string; url: string };
const baselinePath = 'shared/cii-coverage-baseline.json';
const baseline = JSON.parse(readFileSync(new URL(`../${baselinePath}`, import.meta.url), 'utf8'));
const ledger = readFileSync(new URL('../docs/methodology/cii-coverage-ledger.md', import.meta.url), 'utf8');
const exceptions: Exception[] = JSON.parse(ledger.match(/```json\s*([\s\S]*?)```/)![1]).exceptions;
const original: Release = { step: 'C0', scoredCountries: scored, families: { economicStress: expected } };
function transition(before: Release, after: Release, approvals: Exception[]) {
  for (const code of before.scoredCountries) assert.ok(after.scoredCountries.includes(code), `Scored country removed: ${code}`);
  for (const [family, countries] of Object.entries(before.families)) {
    assert.ok(Object.hasOwn(after.families, family), `Recorded family removed: ${family}`);
    for (const code of countries) {
      if (after.families[family].includes(code)) continue;
      assert.ok(approvals.some(a => a.from === before.step && a.to === after.step && a.family === family && a.country === code
        && a.ruling.trim().length > 0 && /^https:\/\/github\.com\/koala73\/worldmonitor\/(issues|pull)\/\d+/.test(a.url)),
      `Expected ${family} country removed without owner ruling: ${code}`);
    }
  }
}
function validate(releases: Release[], approvals: Exception[], previous: Release[] = [original]) {
  assert.ok(releases.length > 0);
  assert.equal(new Set(releases.map(r => r.step)).size, releases.length, 'Duplicate release step');
  const list = (values: string[]) => {
    assert.ok(Array.isArray(values) && values.length > 0);
    assert.equal(new Set(values).size, values.length, 'Duplicate country');
    assert.ok(values.every(c => /^[A-Z]{2}$/.test(c)));
  };
  for (const r of releases) {
    assert.match(r.step, /^C\d+$/);
    list(r.scoredCountries);
    assert.ok(Object.keys(r.families).length > 0);
    for (const values of Object.values(r.families)) list(values);
  }
  previous.forEach((old, index) => {
    assert.equal(releases[index]?.step, old.step, 'Recorded steps must retain their order');
    transition(old, releases[index], approvals);
  });
  for (let i = 1; i < releases.length; i++) transition(releases[i - 1], releases[i], approvals);
}
test('recorded release coverage is well formed and never contracts without a ruling', () => {
  assert.equal(baseline.schemaVersion, 1);
  validate(baseline.releases, exceptions);
});
test('removing Qatar from the recorded floor fails', () => {
  const changed = structuredClone(original);
  changed.families.economicStress = changed.families.economicStress.filter(c => c !== 'QA');
  assert.throws(() => validate([changed], []), /without owner ruling: QA/);
});
test('later scored steps cannot contract', () => {
  const later = { ...structuredClone(original), step: 'C1' };
  later.scoredCountries = later.scoredCountries.filter(c => c !== 'QA');
  assert.throws(() => validate([original, later], []), /Scored country removed: QA/);
});
test('a family removal requires a ruling for the exact step, family and country', () => {
  const later = { ...structuredClone(original), step: 'C1' };
  later.families.economicStress = later.families.economicStress.filter(c => c !== 'QA');
  const approval = { from: 'C0', to: 'C1', family: 'economicStress', country: 'QA', ruling: 'Synthetic owner decision, 2026-11-13; test only', url: 'https://github.com/koala73/worldmonitor/issues/10577' };
  assert.throws(() => validate([original, later], []), /without owner ruling/);
  assert.doesNotThrow(() => validate([original, later], [approval]));
  assert.throws(() => validate([original, later], [{ ...approval, country: 'TW' }]), /without owner ruling/);
  assert.throws(() => validate([original, later], [{ ...approval, ruling: '' }]), /without owner ruling/);
});
test('editing a previously recorded expansion cannot silently lower its floor', () => {
  const previous = { ...structuredClone(original), step: 'C1' };
  previous.families.economicStress.push('KP');
  const changed = { ...structuredClone(original), step: 'C1' };
  assert.throws(() => validate([original, changed], [], [original, previous]), /without owner ruling: KP/);
});
test('the active scored baseline matches the released country list', async () => {
  const { CII_COUNTRY_CODES } = await import('../shared/cii-weights.ts');
  assert.deepEqual([...baseline.releases.at(-1).scoredCountries].sort(), [...CII_COUNTRY_CODES].sort());
});
test('expected-country diagnostics stay operator-only in fresh and cached compact responses', () => {
  const entry = { status: 'COVERAGE_PARTIAL', missingExpectedCountries: ['QA'] };
  const snapshot = { status: 'WARNING', checks: { ciiEconomicStress: entry } };
  assert.equal(health.healthResponseBody(snapshot, true).problems.ciiEconomicStress.missingExpectedCountries, undefined);
  assert.equal(health.healthResponseBody({ status: 'WARNING', problems: { ciiEconomicStress: entry } }, true).problems.ciiEconomicStress.missingExpectedCountries, undefined);
  assert.deepEqual(health.healthResponseBody(snapshot, false).checks.ciiEconomicStress.missingExpectedCountries, ['QA']);
});

test('branch edits preserve the base snapshot coverage and recorded steps', () => {
  const baseRef = `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 0, `Coverage guard needs ${baseRef}; fetch the base before testing: ${result.stderr}`);
    return result.stdout.trim();
  };
  const ref = git(['merge-base', 'HEAD', baseRef]);
  // The first ledger PR has no base file; the pinned original C0 still guards it.
  if (!git(['ls-tree', '--name-only', ref, '--', baselinePath])) return;
  const previous = JSON.parse(git(['show', `${ref}:${baselinePath}`]));
  validate(baseline.releases, exceptions, previous.releases);
});
test('health uses a fresh generated copy of the active baseline', async () => {
  const result = spawnSync(process.execPath, ['scripts/generate-cii-coverage-baseline.mjs', '--check'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const { CII_COVERAGE_BASELINE } = await import('../api/_cii-coverage-baseline.generated.js');
  assert.deepEqual(CII_COVERAGE_BASELINE, baseline.releases.at(-1));
  assert.deepEqual(health.SEED_META.ciiEconomicStress.expectedCountries, CII_COVERAGE_BASELINE.families.economicStress);
});
