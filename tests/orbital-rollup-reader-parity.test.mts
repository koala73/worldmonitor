// Every reader of the per-country watched-site rollup goes through one gate, and that gate
// agrees with the seeder's own isRollupCurrent() on what the seeder publishes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRollupCurrent, planPublication, evaluateSites, ROLLUP_MAX_AGE_MS } from '../scripts/_orbital-sites.mjs';
import { readCountryRollup } from '../shared/orbital/country-rollup.js';
import { projectImagerySignalFamily } from '../shared/country-signal-observations.ts';
import { countryImageryFlagsFrom } from '../server/worldmonitor/intelligence/v1/_country-brief-evidence.ts';
import { imageryChangeContext } from '../server/worldmonitor/intelligence/v1/_imagery-change-context.ts';
import { toCountryEvidence } from '../server/worldmonitor/orbital/v1/get-country-imagery-evidence.ts';
import { CONFIRMED, flagAfter, siteOf } from './helpers/orbital-country-rollup.mjs';

const NOW = Date.UTC(2026, 10, 13, 12);
const natanz = siteOf('nuclear:natanz', 'Natanz Enrichment Facility');

async function published() {
  const evaluation = await evaluateSites({
    sites: [natanz], catalog: { fetchedAt: 0, satellites: [], ring: [] }, previousRecords: new Map(), cursor: null, nowMs: NOW, deadlineMs: Infinity,
    searchArchive: async () => [],
    change: { shadow: false, previousFlags: new Map(), score: async ({ site }: { site: { id: string } }) => flagAfter(site.id, NOW, CONFIRMED), summary: () => ({ shadow: false }) },
  });
  const plan = planPublication({ sites: [natanz], registryVersion: 'test', previousIndex: null, previousRecords: new Map(), evaluation, nowMs: NOW });
  return { rollup: plan.rollupWrites[0], index: plan.index };
}

/** What each surface makes of one (rollup, index) read: shown or not. */
function readers(rollup: unknown, index: unknown, nowMs: number) {
  return {
    brief: countryImageryFlagsFrom({ rollup, index }, 'IR', nowMs).length > 0,
    signals: projectImagerySignalFamily('IR', { rollup, index }, nowMs).state === 'observed',
    risk: imageryChangeContext(rollup, index, 'IR', nowMs) !== undefined,
    rest: !toCountryEvidence('IR', index, rollup, nowMs).stale,
  };
}

describe('one rollup gate for the brief, country signals, risk context and REST', () => {
  it('every reader shows exactly what the seeder considers current', async () => {
    const { rollup, index } = await published();
    const withoutRaised = { ...rollup, sites: rollup.sites.map((s: { flag: { confirmed: Record<string, unknown> } }) => {
      const { raisedBy: _raisedBy, ...confirmed } = s.flag.confirmed;
      return { ...s, flag: { ...s.flag, confirmed } };
    }) };
    const cases: [string, unknown, unknown, number, boolean][] = [
      ['as published', rollup, index, NOW, true],
      ['at the freshness limit', rollup, index, rollup.asOf + ROLLUP_MAX_AGE_MS, true],
      ['past the freshness limit', rollup, index, rollup.asOf + ROLLUP_MAX_AGE_MS + 1, false],
      ['superseded by a newer revision', rollup, { ...index, countries: { IR: { ...index.countries.IR, revision: 'newer' } } }, NOW, false],
      ['index of another schema', rollup, { ...index, schema: 2 }, NOW, false],
      ['index missing', rollup, null, NOW, false],
      ['rollup of another schema', { ...rollup, schema: 2 }, index, NOW, false],
      ['rollup with no asOf', { ...rollup, asOf: undefined }, index, NOW, false],
      ['confirmed before the flag record kept its raising scene', withoutRaised, index, NOW, true],
    ];
    for (const [label, raw, idx, nowMs, current] of cases) {
      assert.equal(isRollupCurrent(raw, idx, nowMs), current, `${label}: seeder`);
      assert.equal(readCountryRollup(raw, idx, 'IR', nowMs).status === 'current', current, `${label}: shared gate`);
      assert.deepEqual(readers(raw, idx, nowMs), { brief: current, signals: current, risk: current, rest: current }, label);
    }
  });

  it('a flag confirmed before its raising scene was recorded still reads, without inventing that scene', async () => {
    const { rollup, index } = await published();
    const [confirmedSite] = rollup.sites;
    delete confirmedSite.flag.confirmed.raisedBy;
    const [flag] = countryImageryFlagsFrom({ rollup, index }, 'IR', NOW);
    assert.equal(flag?.raised, null);
    const [observation] = projectImagerySignalFamily('IR', { rollup, index }, NOW).observations;
    assert.match(observation!.title, /^Imagery statistics changed at Natanz Enrichment Facility: confirmed by Sentinel-1C scene /);
  });
});
