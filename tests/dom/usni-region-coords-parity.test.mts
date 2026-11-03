import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { USNI_REGION_COORDINATES, getUSNIRegionCoords } from '@/config/military';

// Lives under tests/dom because src/config/military.ts reads import.meta.env at
// module scope, which only the Vite pipeline provides; the tsx node:test runner
// cannot import it. The parser is plain CommonJS and loads from either side.
const require = createRequire(import.meta.url);
const {
  USNI_REGION_COORDS,
  usniGetRegionCoords,
} = require('../../scripts/lib/usni-fleet-parser.cjs') as {
  USNI_REGION_COORDS: Record<string, { lat: number; lon: number }>;
  usniGetRegionCoords: (regionText: string) => { lat: number; lon: number } | null;
};

// Every distinct <h2> heading from the 46 USNI Fleet Tracker posts published
// between 2025-11-24 and 2026-09-08 (WordPress API, categories=4137), read on
// 2026-09-13. The parser seeds regionLat/regionLon from these strings and the
// client re-resolves the same strings at render time, so both lookups must
// agree on every one of them. Add to this list when USNI publishes a new
// heading — a heading that resolves nowhere falls through to a hash-derived
// position on the client (#7548).
const PUBLISHED_HEADINGS = [
  'In Japan', 'In the South China Sea', 'In Singapore', 'In the Southern Pacific',
  'In the Caribbean', 'In Norway', 'In the Mediterranean Sea', 'In the Red Sea',
  'In the Arabian Sea', 'In the Indian Ocean', 'In the Eastern Pacific',
  'In the Western Atlantic', 'In the California Operating Area', 'In Sasebo, Japan',
  'In San Diego', 'In Da Nang, Vietnam', 'In the Hawaiian Operating Areas', 'In Panama',
  'In the Caribbean Sea', 'In the Philippine Sea', 'In the Persian Gulf',
  'In the Eastern Mediterranean Sea', 'In the Antarctic', 'In Pearl Harbor, Hawaii',
  'In the East China Sea', 'In the Western Pacific', 'In the Pacific',
  'In the North Arabian Sea', 'In the South Atlantic', 'In the South Pacific',
  'In the Andaman Sea', 'In the Eastern Mediterranean', 'In Yokosuka, Japan',
  'In Okinawa, Japan', 'In Manila, Philippines', 'In the Atlantic',
  'In La Guaira, Venezuela', 'In Phuket, Thailand', 'In the Mediterranean',
  'Near Pearl Harbor, Hawaii', 'In Zeebrugge, Belgium', 'In New York City',
  'Exercise Valiant Shield', 'In Hawaii', 'Across the Sea of Japan, East China Sea and Philippine Sea',
  'In Vladivostok, Russia', 'Through the Tsushima Strait to the East China Sea',
  'In the Miyako Strait', 'From the Tsushima Strait to Miyako Strait',
  'Near Yonaguni Island to the Tsushima Strait', 'In the Osumi Strait',
  'Near Amami Oshima and Yokoate Island', 'In the La Perouse Strait', 'In Hong Kong',
  'Near Scarborough Shoal', 'In the North Sea', 'In Kiel, Germany', 'In the Baltic Sea',
  'In the English Channel', 'In Kingston, Jamaica', 'In Portsmouth, England',
  'In New Orleans', 'In Rota, Spain', 'East of Okinawa, Japan', 'Near Honshu, Japan',
  'In Southwest Japan', 'In Shimoda, Japan', 'In Kure, Japan', 'In Wellington, New Zealand',
  'In the Solomon Islands', 'In Tanjung Priok, North Jakarta, Indonesia',
  'In the Strait of Malacca', 'In the Atlantic Ocean', 'In the Sulu Sea',
  'In the Southern Indian Ocean', 'In Houston, Texas', 'In the Southern Atlantic',
  'In Mayport, Fla.', 'In Laem Chabang, Thailand', 'In Split, Croatia', 'In Diego Garcia',
  'In New Zealand', 'Near the Gulf Coast', 'In Souda Bay, Crete', 'In the Tasman Sea',
  'In the Eastern Atlantic', 'In St. Thomas', 'In the Pacific Ocean', 'In the Gulf of Aden',
];

// A heading that the tables can resolve but only to the wrong place is the
// failure this guards against. Each expectation names the key the heading must
// land on, so a new shorter alias cannot silently steal a longer match.
const EXPECTED_RESOLUTION: Array<[string, string]> = [
  ['In Sasebo, Japan', 'Sasebo'],
  ['In Okinawa, Japan', 'Okinawa'],
  // The city is the shorter key here, so longest-match alone would pick the country.
  ['In Kure, Japan', 'Kure'],
  ['In Wellington, New Zealand', 'Wellington'],
  ['In Portsmouth, England', 'Portsmouth, England'],
  ['Near Portsmouth, England', 'Portsmouth, England'],
  ['Across the Sea of Japan, East China Sea and Philippine Sea', 'Sea of Japan'],
  ['In the Eastern Mediterranean Sea', 'Eastern Mediterranean'],
  ['In the Southern Pacific', 'Southern Pacific'],
  ['In the North Arabian Sea', 'North Arabian Sea'],
  ['In the Hawaiian Operating Areas', 'Hawaiian Operating Areas'],
  ['In Manila, Philippines', 'Manila'],
  ['In Norway', 'Norway'],
  ['In the Caribbean', 'Caribbean'],
];

describe('USNI region coordinate tables', () => {
  it('keeps the parser and client tables identical', () => {
    expect(USNI_REGION_COORDS).toStrictEqual(USNI_REGION_COORDINATES);
  });

  it('holds only finite coordinates inside the WGS84 envelope', () => {
    for (const [key, { lat, lon }] of Object.entries(USNI_REGION_COORDS)) {
      expect(Number.isFinite(lat) && Math.abs(lat) <= 90, `${key} lat ${lat}`).toBe(true);
      expect(Number.isFinite(lon) && Math.abs(lon) <= 180, `${key} lon ${lon}`).toBe(true);
      expect(lat === 0 && lon === 0, `${key} sits on null island`).toBe(false);
    }
  });

  it('resolves every heading USNI has published, identically on both sides', () => {
    const unresolved: string[] = [];
    const disagreements: string[] = [];
    for (const heading of PUBLISHED_HEADINGS) {
      const seeded = usniGetRegionCoords(heading);
      const rendered = getUSNIRegionCoords(heading);
      if (!seeded || !rendered) {
        unresolved.push(heading);
        continue;
      }
      if (seeded.lat !== rendered.lat || seeded.lon !== rendered.lon) disagreements.push(heading);
    }
    expect(unresolved, 'headings with no coordinates').toEqual([]);
    expect(disagreements, 'headings where parser and client disagree').toEqual([]);
  });

  it('prefers the most specific key for compound and City, Country headings', () => {
    for (const [heading, key] of EXPECTED_RESOLUTION) {
      expect(usniGetRegionCoords(heading), `parser: ${heading}`).toEqual(USNI_REGION_COORDS[key]);
      expect(getUSNIRegionCoords(heading), `client: ${heading}`).toEqual(USNI_REGION_COORDINATES[key]);
    }
  });

  it('still reports a genuinely unknown heading instead of guessing', () => {
    expect(usniGetRegionCoords('In the Sea of Nowhere')).toBeNull();
    expect(getUSNIRegionCoords('In the Sea of Nowhere')).toBeUndefined();
    // A comma heading whose segments are all unknown must not resolve either.
    expect(usniGetRegionCoords('In Nowhere, Atlantis')).toBeNull();
    expect(getUSNIRegionCoords('In Nowhere, Atlantis')).toBeUndefined();
  });
});
