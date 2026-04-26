// Plan 2026-04-26-002 §U2 (PR 1) — universe filter test.
//
// Pins the rankable-universe whitelist (193 UN members + 3 SARs) and
// the `isInRankableUniverse` helper that both seeders consume to ensure
// their universes match.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  isInRankableUniverse,
  getSovereignStatus,
  listRankableCountries,
  RANKABLE_UNIVERSE_SIZE,
} from '../scripts/shared/rankable-universe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SOVEREIGN_STATUS_PATH = resolve(
  here,
  '../server/worldmonitor/resilience/v1/registries/sovereign-status.json',
);

describe('rankable-universe whitelist (Plan 2026-04-26-002 §U2)', () => {
  it('contains exactly 193 UN members + 3 SARs = 196 entries', () => {
    const raw = JSON.parse(readFileSync(SOVEREIGN_STATUS_PATH, 'utf8'));
    const unMembers = raw.entries.filter((e: { status: string }) => e.status === 'un-member');
    const sars = raw.entries.filter((e: { status: string }) => e.status === 'sar');
    assert.equal(unMembers.length, 193, `Expected 193 UN members, got ${unMembers.length}`);
    assert.equal(sars.length, 3, `Expected 3 SARs (HK, MO, TW), got ${sars.length}`);
    assert.equal(RANKABLE_UNIVERSE_SIZE, 196, `Helper module sees ${RANKABLE_UNIVERSE_SIZE} countries, expected 196`);
  });

  it('SAR cohort is exactly {HK, MO, TW}', () => {
    const raw = JSON.parse(readFileSync(SOVEREIGN_STATUS_PATH, 'utf8'));
    const sarSet = new Set(
      raw.entries
        .filter((e: { status: string }) => e.status === 'sar')
        .map((e: { iso2: string }) => e.iso2),
    );
    assert.deepEqual([...sarSet].sort(), ['HK', 'MO', 'TW']);
  });

  it('no duplicate ISO2 entries', () => {
    const raw = JSON.parse(readFileSync(SOVEREIGN_STATUS_PATH, 'utf8'));
    const isos: string[] = raw.entries.map((e: { iso2: string }) => e.iso2);
    const dups = isos.length - new Set(isos).size;
    assert.equal(dups, 0, `Found ${dups} duplicate ISO2 entries in sovereign-status.json`);
  });
});

describe('isInRankableUniverse() (Plan 2026-04-26-002 §U2)', () => {
  it('passes well-known UN-member ISO2 codes', () => {
    const samples = ['DE', 'JP', 'US', 'BR', 'IN', 'NG', 'KE', 'TV', 'NR', 'PW'];
    for (const iso of samples) {
      assert.equal(isInRankableUniverse(iso), true, `${iso} should be in rankable universe`);
    }
  });

  it('passes the 3 SARs (HK, MO, TW)', () => {
    for (const iso of ['HK', 'MO', 'TW']) {
      assert.equal(isInRankableUniverse(iso), true, `${iso} (SAR) should be in rankable universe`);
      assert.equal(getSovereignStatus(iso), 'sar', `${iso} sovereign status should be 'sar'`);
    }
  });

  it('rejects non-sovereign territories', () => {
    // Common non-rankable territories that the v15 universe currently includes
    // and PR 1 must filter out.
    const territories = ['AS', 'GU', 'GL', 'IM', 'GI', 'FK', 'MP', 'VI', 'PR', 'BM', 'KY', 'TC', 'AI', 'MS', 'AW', 'CW', 'SX', 'PF', 'NC', 'WF', 'YT', 'RE', 'BL', 'MF', 'PM'];
    for (const iso of territories) {
      assert.equal(isInRankableUniverse(iso), false, `${iso} (territory) should NOT be in rankable universe`);
    }
  });

  it('rejects non-UN-recognized entities', () => {
    // Kosovo (XK), Palestine (PS), Vatican (VA), Western Sahara (EH) are
    // commonly seen in datasets but are NOT UN members. Per Q1 decision
    // they fall outside the rankable universe.
    for (const iso of ['XK', 'PS', 'VA', 'EH']) {
      assert.equal(isInRankableUniverse(iso), false, `${iso} (non-UN) should NOT be in rankable universe`);
    }
  });

  it('handles case-insensitive ISO2 input', () => {
    assert.equal(isInRankableUniverse('de'), true);
    assert.equal(isInRankableUniverse('De'), true);
    assert.equal(isInRankableUniverse('DE'), true);
  });

  it('rejects invalid input shapes', () => {
    assert.equal(isInRankableUniverse(''), false);
    assert.equal(isInRankableUniverse('USA'), false); // ISO3, not ISO2
    assert.equal(isInRankableUniverse('X'), false);
    assert.equal(isInRankableUniverse(null as unknown as string), false);
    assert.equal(isInRankableUniverse(undefined as unknown as string), false);
  });
});

describe('getSovereignStatus() (Plan 2026-04-26-002 §U2)', () => {
  it('returns "un-member" for UN members', () => {
    for (const iso of ['DE', 'JP', 'US', 'NO', 'TV']) {
      assert.equal(getSovereignStatus(iso), 'un-member');
    }
  });

  it('returns "sar" for HK/MO/TW', () => {
    for (const iso of ['HK', 'MO', 'TW']) {
      assert.equal(getSovereignStatus(iso), 'sar');
    }
  });

  it('returns null for non-rankable entities', () => {
    for (const iso of ['GL', 'IM', 'XK', 'INVALID']) {
      assert.equal(getSovereignStatus(iso), null);
    }
  });
});

describe('listRankableCountries() (Plan 2026-04-26-002 §U2)', () => {
  it('returns 196 sorted ISO2 codes', () => {
    const list = listRankableCountries();
    assert.equal(list.length, 196);
    const sorted = [...list].sort();
    assert.deepEqual(list, sorted, 'list should be alphabetically sorted');
  });

  it('includes all expected anchor countries', () => {
    const list = new Set(listRankableCountries());
    for (const iso of ['DE', 'JP', 'US', 'NO', 'TV', 'PW', 'NR', 'HK', 'MO', 'TW']) {
      assert.ok(list.has(iso), `Anchor country ${iso} missing from rankable universe`);
    }
  });

  it('excludes all expected non-anchor territories', () => {
    const list = new Set(listRankableCountries());
    for (const iso of ['AS', 'GU', 'GL', 'IM', 'GI', 'FK', 'XK', 'PS']) {
      assert.equal(list.has(iso), false, `Non-anchor ${iso} should NOT be in rankable universe`);
    }
  });
});
