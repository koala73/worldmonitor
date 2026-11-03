import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';

import {
  MIN_DISPLACEMENT_COUNTRIES,
  contentMeta,
  declareRecords,
  seedOptions,
  validate,
} from '../scripts/seed-displacement-summary.mjs';

function payloadWithCountries(count) {
  return {
    summary: {
      year: new Date().getUTCFullYear(),
      globalTotals: { refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, total: 0 },
      countries: Array.from({ length: count }, (_, index) => ({
        code: `X${index}`,
        name: `Country ${index}`,
        totalDisplaced: 0,
        hostTotal: 0,
      })),
      topFlows: [],
    },
  };
}

describe('seed-displacement-summary validation floor', () => {
  it('rotates the publication source year in UTC across local year boundaries', () => {
    for (const [timezone, instant, expectedYear] of [
      ['America/Los_Angeles', '2027-01-01T00:30:00Z', 2027],
      ['Pacific/Kiritimati', '2026-12-31T23:30:00Z', 2026],
    ]) {
      const script = `
        const NativeDate = Date;
        let clock = ${JSON.stringify(instant)};
        globalThis.Date = class extends NativeDate {
          constructor(...args) { super(...(args.length ? args : [clock])); }
        };
        const requestedYears = [];
        globalThis.fetch = async url => {
          requestedYears.push(Number(new URL(url).searchParams.get('year')));
          return Response.json({ maxPages: 1, items: [
            { coo_iso: 'SYR', coo_name: 'Syria', coa_iso: 'DEU', coa_name: 'Germany', refugees: 12, asylum_seekers: 3, idps: 900, stateless: 80 },
            { coo_iso: 'SYR', coo_name: 'Syria', coa_iso: 'DEU', coa_name: 'Germany', refugees: 5, asylum_seekers: 2, idps: 100, stateless: 20 },
          ] });
        };
        const { seedOptions, fetchDisplacementSummary } = await import(${JSON.stringify(new URL('../scripts/seed-displacement-summary.mjs', import.meta.url).href)});
        clock = '${expectedYear + 1}-01-01T00:30:00Z';
        const result = await fetchDisplacementSummary();
        console.log(JSON.stringify({ sourceVersion: seedOptions.sourceVersion, requestedYears, summary: result.summary }));
      `;
      const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { PATH: process.env.PATH, TZ: timezone, NODE_ENV: 'test', VITEST: '1' }, encoding: 'utf8',
      });
      const value = JSON.parse(result);
      assert.equal(value.sourceVersion, `unhcr-${expectedYear}`);
      assert.deepEqual(value.requestedYears, [expectedYear]);
      assert.equal(value.summary.year, expectedYear);
      const origin = value.summary.countries.find(country => country.code === 'SYR');
      assert.equal(origin.refugees + origin.asylumSeekers, 22);
      const host = value.summary.countries.find(country => country.code === 'DEU');
      assert.equal(host.refugees + host.asylumSeekers, 0);
      assert.equal(host.hostTotal, 22);
    }
  });
  it('rejects a one-country partial UNHCR payload', () => {
    assert.equal(validate(payloadWithCountries(1)), false);
  });

  it('returns strict false for missing payloads', () => {
    assert.equal(validate(null), false);
    assert.equal(validate(undefined), false);
  });

  it('rejects payloads below the displacement country floor', () => {
    assert.equal(validate(payloadWithCountries(MIN_DISPLACEMENT_COUNTRIES - 1)), false);
  });

  it('accepts payloads at the displacement country floor', () => {
    assert.equal(validate(payloadWithCountries(MIN_DISPLACEMENT_COUNTRIES)), true);
  });

  it('declares the same country count that validation gates', () => {
    const payload = payloadWithCountries(MIN_DISPLACEMENT_COUNTRIES);
    assert.equal(declareRecords(payload), MIN_DISPLACEMENT_COUNTRIES);
  });

  it('treats sub-floor validation failure as a strict seeder failure', () => {
    assert.equal(seedOptions.emptyDataIsFailure, true);
    assert.equal(seedOptions.validateFn(payloadWithCountries(MIN_DISPLACEMENT_COUNTRIES - 1)), false);
  });

  it('reports content age from the actual UNHCR data year', () => {
    const payload = payloadWithCountries(MIN_DISPLACEMENT_COUNTRIES);
    payload.summary.year = 2024;

    assert.deepEqual(contentMeta(payload), {
      newestItemAt: Date.parse('2024-12-31T00:00:00.000Z'),
      oldestItemAt: Date.parse('2024-12-31T00:00:00.000Z'),
    });
    assert.equal(contentMeta({ summary: { year: null } }), null);
    assert.equal(seedOptions.maxContentAgeMin, 20 * 30 * 24 * 60);
  });
});
