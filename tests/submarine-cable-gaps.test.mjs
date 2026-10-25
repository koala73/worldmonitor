import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-submarine-cable-gaps.mjs', import.meta.url));

function runGapScan(mode, cliArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-cable-gaps-'));
  const out = join(dir, 'report.md');
  writeFileSync(out, 'last complete report');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(cliArgs ?? ['--out', out])}];
      const mode = ${JSON.stringify(mode)};
      globalThis.fetch = async (input) => {
        if (mode === 'invalid-args') console.error('unexpected-fetch');
        if (String(input).endsWith('/all.json')) {
          if (mode === 'catalog-http') return Response.json({}, { status: 503 });
          if (mode === 'catalog-shape') return Response.json({ error: 'unavailable' });
          const cables = [{ id: 'fixture-missing-cable', name: 'Fixture cable' }];
          if (mode === 'partial') cables.push({ id: 'fixture-unreadable-cable', name: 'Unreadable cable' });
          return Response.json(cables);
        }
        if (mode === 'network') throw new Error('fixture connection failure');
        if (mode === 'http') return Response.json({ message: 'rate limited' }, { status: 429 });
        if (mode === 'json') return new Response('<html>not JSON</html>');
        if (mode === 'shape') return Response.json({ name: 'Fixture cable' });
        if (mode === 'partial' && String(input).includes('fixture-unreadable-cable')) {
          throw new Error('fixture connection failure');
        }
        return Response.json({
          name: 'Fixture cable', is_planned: false, rfs_year: 2020, length: '100 km',
          landing_points: mode === 'empty' ? [] : [{ country: 'Country A' }, { country: 'Country B' }],
        });
      };
      await import(${JSON.stringify(new URL('../scripts/check-submarine-cable-gaps.mjs', import.meta.url).href)});
    `], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'test', WM_ALLOW_ENV_LOAD_IN_TESTS: '0' },
      timeout: 10_000,
    });
    assert.ifError(result.error);
    return { ...result, report: readFileSync(out, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('submarine cable gap CLI', () => {
  for (const args of [
    ['--out'], ['--out', '--min-countries', '2'],
    ['--min-countries'], ['--min-countries', 'abc'], ['--min-countries', '0'],
    ['--min-countries', '-1'], ['--min-countries', '1.5'], ['--min-countries', 'Infinity'],
  ]) {
    it(`rejects invalid options before fetching: ${args.join(' ')}`, () => {
      const result = runGapScan('invalid-args', args);
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(result.report, 'last complete report');
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /unexpected-fetch/);
    });
  }

  it('writes a complete report when every detail request succeeds', () => {
    const result = runGapScan('valid');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.report, /Missing in-service cables landing in 2\+ countries: 1/);
    assert.match(result.report, /fixture-missing-cable \| Fixture cable/);
  });

  it('accepts a confirmed empty result', () => {
    const result = runGapScan('empty');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.report, /Missing in-service cables landing in 2\+ countries: 0/);
  });

  for (const mode of ['network', 'http', 'json', 'shape']) {
    it(`fails without overwriting a complete report on ${mode} detail failures`, () => {
      const result = runGapScan(mode);
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(result.report, 'last complete report');
      assert.match(result.stderr, /incomplete/i);
      assert.match(result.stderr, /fixture-missing-cable/);
    });
  }

  for (const mode of ['catalog-http', 'catalog-shape']) {
    it(`fails without overwriting a complete report on ${mode} failures`, () => {
      const result = runGapScan(mode);
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(result.report, 'last complete report');
    });
  }

  it('rejects a partial scan even when another cable was read successfully', () => {
    const result = runGapScan('partial');
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.report, 'last complete report');
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Incomplete cable gap scan \(1 failed\)/);
    assert.match(result.stderr, /fixture-unreadable-cable/);
  });
});
