import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  SENSOR_CATEGORIES,
  SENSOR_INVENTORY_VERSION,
  SENSOR_PROFILES,
  matchSensorProfile,
} from '../shared/orbital/sensor-profiles.js';

import { findPasses, parseOrbitElements } from '../shared/orbital/pass-geometry.js';
import type { OmmRecord } from '../shared/orbital/pass-geometry.js';
import { decidePassTier } from '../shared/orbital/tiers.js';

const readFixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/orbital/${name}`, import.meta.url), 'utf8'));
const { records } = readFixture('celestrak-gp-2026-11-13.json') as { records: OmmRecord[] };
const { records: widened } = readFixture('celestrak-gp-2026-11-14.json') as { records: OmmRecord[] };
// Every active CelesTrak name on 2026-11-14, plus every SATCAT record named YAOGAN (payloads and debris).
const names = readFixture('celestrak-names-2026-11-14.json') as {
  active: Array<[number, string]>;
  yaoganSatcat: Array<[number, string, 'PAY' | 'DEB', string | null]>;
};
const GCAT = 'https://planet4589.org/space/gcat/data/cat/psatcat.html';
const DAY = 86_400_000;

describe('sensor profile inventory', () => {
  it('carries a version', () => {
    assert.match(SENSOR_INVENTORY_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it('cites an https source for every row and uses a known category', () => {
    for (const profile of SENSOR_PROFILES) {
      assert.ok(profile.sources.length > 0, `${profile.id} cites a source`);
      for (const source of profile.sources) assert.equal(new URL(source).protocol, 'https:', `${profile.id} source ${source}`);
      assert.ok(SENSOR_CATEGORIES.includes(profile.category), `${profile.id} category ${profile.category}`);
    }
  });

  it('keeps profile ids and NORAD ids unique', () => {
    const ids = SENSOR_PROFILES.map((profile) => profile.id);
    assert.equal(new Set(ids).size, ids.length);
    const norad = SENSOR_PROFILES.flatMap((profile) => profile.noradIds);
    assert.equal(new Set(norad).size, norad.length);
  });

  it('gives open missions a publication delay and weather sensors a daily mosaic', () => {
    for (const profile of SENSOR_PROFILES) {
      if (profile.category === 'open-optical' || profile.category === 'open-radar') assert.ok((profile.archiveWaitHours ?? 0) > 0, `${profile.id} archive wait`);
      if (profile.category === 'weather-polar') assert.equal(profile.dailyMosaic, true, `${profile.id} daily mosaic`);
    }
  });

  it('states resolution, daylight need and archive collection on every row', () => {
    for (const profile of SENSOR_PROFILES) {
      assert.ok(profile.resolutionM === null || profile.resolutionM > 0, `${profile.id} resolution`);
      assert.equal(typeof profile.daylight, 'boolean', `${profile.id} daylight`);
      assert.ok(profile.archive === null || typeof profile.archive === 'string', `${profile.id} archive`);
      if (profile.category.endsWith('-optical')) assert.equal(profile.daylight, true, `${profile.id} is passive optical`);
      if (profile.category.endsWith('-radar') || profile.category === 'open-lidar') assert.equal(profile.daylight, false, `${profile.id} brings its own illumination`);
    }
  });

  it('cites a mission document, not only the catalogue, for every stated number', () => {
    for (const profile of SENSOR_PROFILES) {
      const states = profile.resolutionM !== null || (profile.footprint.kind === 'steerable' && !profile.footprint.assumed);
      if (states) assert.ok(profile.sources.some((source) => source !== GCAT), `${profile.id} cites where its numbers come from`);
    }
  });

  it('profiles ICESat-2 as a lidar altimeter and VIIRS on both NOAA archive satellites', () => {
    const icesat = SENSOR_PROFILES.find((profile) => profile.id === 'icesat-2');
    assert.equal(icesat?.category, 'open-lidar');
    assert.deepEqual(icesat?.noradIds, [43613]);
    assert.deepEqual(SENSOR_PROFILES.find((profile) => profile.id === 'viirs')?.noradIds, [37849, 43013]);
  });

  it('waits at least the measured 95th-percentile publication lag of the quickest archive', () => {
    const { publicationLag } = JSON.parse(readFileSync(new URL('../docs/audits/orbital-live-check-2026-11-14.json', import.meta.url), 'utf8')) as {
      publicationLag: Record<string, { waitHours: number | null }>;
    };
    for (const id of ['sentinel-2', 'sentinel-1', 'landsat']) {
      const measured = publicationLag[id]?.waitHours;
      assert.ok(typeof measured === 'number' && measured > 0, `${id} lag was measured`);
      const profile = SENSOR_PROFILES.find((p) => p.id === id)!;
      assert.ok(profile.archiveWaitHours! >= measured, `${id} waits ${profile.archiveWaitHours} h, measured ${measured} h`);
    }
    assert.equal(SENSOR_PROFILES.find((p) => p.id === 'landsat')!.archiveWaitHours, publicationLag.landsat!.waitHours, 'Landsat is set from the measurement');
  });
});

describe('recorded CelesTrak names', () => {
  it('matches the expected number of active satellites per family', () => {
    const counts: Record<string, number> = {};
    for (const [noradId, name] of names.active) {
      const profile = matchSensorProfile(noradId, name);
      if (profile) counts[profile.id] = (counts[profile.id] ?? 0) + 1;
    }
    assert.deepEqual(counts, {
      'sentinel-2': 3, 'sentinel-1': 3, landsat: 2, modis: 2, viirs: 2, 'icesat-2': 1,
      capella: 11, iceye: 60, umbra: 7, 'terrasar-x': 2,
      worldview: 9, pleiades: 4, skysat: 14, blacksky: 16, superview: 7, 'jilin-1': 34,
      gaofen: 10, 'gaofen-3': 3, kompsat: 4, 'kompsat-5': 1, rasat: 1,
      yaogan: 36, 'gaofen-military': 20, 'russian-reconnaissance': 22, 'sar-lupe': 1,
      'cosmo-skymed': 7, paz: 1, gokturk: 2, cartosat: 7,
      iss: 1, goes: 2, himawari: 1, 'meteosat-third-generation': 1,
    });
  });

  it('lists only satellites that are active today by NORAD id', () => {
    const active = new Set(names.active.map(([noradId]) => noradId));
    for (const profile of SENSOR_PROFILES) {
      for (const noradId of profile.noradIds) assert.ok(active.has(noradId), `${profile.id} ${noradId} is active`);
    }
  });

  it('matches Yaogan imaging payloads, not debris or the signals-intelligence triplets', () => {
    const matched = names.yaoganSatcat.filter(([noradId, name]) => matchSensorProfile(noradId, name)?.id === 'yaogan');
    assert.ok(matched.every(([, , type]) => type === 'PAY'), 'no debris matches');
    assert.ok(matched.some(([, name]) => name === 'RSS-1 (YAOGAN-1)'));
    for (const name of ['YAOGAN-9 01A', 'YAOGAN-30 02C', 'YAOGAN OBJECT A', 'YAOGAN-1 DEB', 'YAOGAN 25C DEB']) {
      assert.equal(matchSensorProfile(999_999, name), null, name);
    }
    const kosmos = names.active.filter(([noradId, name]) => name.startsWith('COSMOS') && !matchSensorProfile(noradId, name));
    assert.ok(kosmos.length > 0, 'Kosmos navigation and communications payloads stay unprofiled');
  });
});

describe('next passes for the widened inventory', () => {
  const satellite = (name: string) => {
    const omm = widened.find((record) => record.OBJECT_NAME === name);
    assert.ok(omm, `fixture has ${name}`);
    const elements = parseOrbitElements(omm);
    const profile = matchSensorProfile(elements.noradId, elements.name);
    assert.ok(profile, `${name} has a profile`);
    return { elements, profile };
  };
  const now = Date.parse('2026-11-14T12:00:00Z');

  it('gives ICESat-2 a next pass over Lake Mead as an opportunity', () => {
    const { elements, profile } = satellite('ICESAT-2');
    // Its 91-day repeat leaves no fixture track over the lake until the 30 November crossing of Boulder Basin.
    const lookupAt = Date.parse('2026-11-21T00:00:00Z');
    const result = findPasses({ elements, profile, point: { lat: 36.1, lon: -114.8 }, window: { start: lookupAt, end: lookupAt + 10 * DAY }, now: lookupAt });
    assert.equal(result.status, 'ok');
    const next = result.passes.find((pass) => pass.inFootprint);
    assert.ok(next, 'the beam envelope crosses Boulder Basin within the window');
    assert.equal(next.time.slice(0, 10), '2026-11-30');
    assert.equal(next.opportunity, true);
    assert.deepEqual(decidePassTier(next, profile, null, lookupAt), { kind: 'opportunity' });
  });

  for (const name of ['SUOMI NPP', 'NOAA 20 (JPSS-1)']) {
    it(`gives ${name} a daily VIIRS mosaic`, () => {
      const { elements, profile } = satellite(name);
      const result = findPasses({ elements, profile, point: { lat: -1.29, lon: 36.82 }, window: { start: now - DAY, end: now }, now });
      const tiers = result.passes.filter((pass) => pass.inFootprint).map((pass) => decidePassTier(pass, profile, null, now).kind);
      assert.ok(tiers.includes('daily-mosaic'), `${name} tiers: ${tiers.join(', ')}`);
    });
  }
});

describe('matchSensorProfile', () => {
  it('matches every fixture satellite', () => {
    for (const omm of records) assert.ok(matchSensorProfile(omm.NORAD_CAT_ID, omm.OBJECT_NAME), omm.OBJECT_NAME);
  });

  it('prefers the NORAD id over the name', () => {
    assert.equal(matchSensorProfile(40697, 'LANDSAT 9')?.id, 'sentinel-2');
  });

  it('falls back to the name pattern for a satellite not yet listed by id', () => {
    assert.equal(matchSensorProfile(999_999, 'SENTINEL-2D')?.id, 'sentinel-2');
    assert.equal(matchSensorProfile(999_999, 'yaogan-45')?.id, 'yaogan');
    assert.equal(matchSensorProfile(999_999, 'CAPELLA-30 (ACADIA-20)')?.id, 'capella');
    assert.equal(matchSensorProfile(999_999, 'YAOGAN-60 02')?.id, 'yaogan');
    assert.equal(matchSensorProfile(999_999, 'ICEYE-X99')?.id, 'iceye');
    assert.equal(matchSensorProfile(999_999, 'LEGION 7')?.id, 'worldview');
  });

  it('returns null for an unprofiled satellite', () => {
    assert.equal(matchSensorProfile(999_999, 'STARLINK-1007'), null);
    assert.equal(matchSensorProfile(999_999, null), null);
  });
});
