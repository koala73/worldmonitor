import { readFileSync } from 'node:fs';
import { matchSensorProfile } from '../../shared/orbital/sensor-profiles.js';
import type { OmmRecord } from '../../shared/orbital/pass-geometry.js';
import type { PointPassLookup } from '../../src/services/orbital/pass-client.ts';
import { runPassJob, type CatalogSatellite } from '../../src/services/orbital/pass-job.ts';

const readFixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/orbital/${name}`, import.meta.url), 'utf8'));

type FeatureCollection = { type: 'FeatureCollection'; features: Array<Record<string, any>> };
export interface ArchiveFixturePoint {
  lat: number;
  lon: number;
  'earth-search': FeatureCollection;
  'planetary-computer': FeatureCollection;
}
export const ARCHIVE_RESPONSES = readFixture('archive-responses-2026-11-13.json') as {
  window: string;
  points: Record<'denver' | 'dubai', ArchiveFixturePoint>;
};

export const FIXTURE_NOW = Date.parse('2026-11-13T12:00:00Z');
const [windowStart, windowEnd] = ARCHIVE_RESPONSES.window.split('/');
export const FIXTURE_WINDOW = { startMs: Date.parse(windowStart!), endMs: Date.parse(windowEnd!) };

const { records } = readFixture('celestrak-gp-2026-11-13.json') as { records: OmmRecord[] };
const satellites: CatalogSatellite[] = records.flatMap((record) => {
  const profile = matchSensorProfile(record.NORAD_CAT_ID, record.OBJECT_NAME);
  return profile ? [{ noradId: Number(record.NORAD_CAT_ID), name: record.OBJECT_NAME, profileId: profile.id, elementSets: [record] }] : [];
});

export async function fixtureLookup(point: { lat: number; lon: number }): Promise<PointPassLookup> {
  const { passes, satellites: outcomes } = await runPassJob({ point, window: FIXTURE_WINDOW, nowMs: FIXTURE_NOW, satellites });
  return {
    point,
    window: FIXTURE_WINDOW,
    nowMs: FIXTURE_NOW,
    catalog: { status: 'fresh', fetchedAt: FIXTURE_NOW, inventoryVersion: 'fixture' } as PointPassLookup['catalog'],
    passes,
    satellites: outcomes,
    computedOn: 'main-thread',
  };
}

export interface FakeArchiveOptions {
  /** Hostnames that answer 503. */
  failing?: string[];
  /** URL substrings that answer 503. */
  failingPaths?: string[];
  /** Hostnames whose requests never settle. */
  stalled?: string[];
  /** Hostnames whose requests reject as a network error whose message carries the URL. */
  unreachable?: string[];
  /** Sentinel-2 scene classification value at the point. */
  scl?: number;
  /** Landsat QA_PIXEL value at the point. */
  qaPixel?: number;
  /** Extra Planetary Computer features appended to the search answer. */
  extraPlanetaryComputer?: Array<Record<string, any>>;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const xml = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/xml' } });

/** Answers archive requests from the recorded responses and records every URL the lookup requested. */
export function fakeArchiveFetch(point: ArchiveFixturePoint, options: FakeArchiveOptions = {}) {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    requests.push({ url: input, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined });
    if (options.unreachable?.includes(url.hostname)) throw new TypeError(`Failed to fetch ${input}`);
    if (options.stalled?.includes(url.hostname)) return new Promise<Response>(() => {});
    if (options.failing?.includes(url.hostname) || options.failingPaths?.some((part) => input.includes(part))) {
      return new Response('unavailable', { status: 503 });
    }
    if (url.hostname === 'earth-search.aws.element84.com') return json(point['earth-search']);
    if (url.hostname === 'planetarycomputer.microsoft.com' && url.pathname.endsWith('/search')) {
      const answer = point['planetary-computer'];
      return json({ ...answer, features: [...answer.features, ...(options.extraPlanetaryComputer ?? [])] });
    }
    if (url.hostname === 'planetarycomputer.microsoft.com' && url.pathname.endsWith('/item/statistics')) {
      const value = url.searchParams.get('assets') === 'SCL' ? options.scl ?? 4 : options.qaPixel ?? 21824;
      return json({ type: 'Feature', properties: { statistics: { b1: { majority: value, count: 1 } } } });
    }
    if (url.hostname === 'gibs.earthdata.nasa.gov') {
      const daily = url.pathname.includes('CorrectedReflectance');
      return xml(`<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>${daily ? '2026-11-03/2026-11-13/P1D' : '2026-11-13T06:00:00Z/2026-11-13T11:50:00Z/PT10M'}</Domain></DimensionDomain></Domains>`);
    }
    if (url.hostname === 'view.eumetsat.int') {
      return xml('<Layer><Dimension name="time" default="2026-11-13T11:50:00Z" units="ISO8601">2024-09-23T00:00:00.000Z/2026-11-13T11:50:00.000Z/PT10M</Dimension></Layer>');
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, requests };
}
