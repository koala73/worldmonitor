import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AisPositionData } from '@/services/maritime';
import type { MilitaryVessel, USNIFleetReport } from '@/types';

const stream = vi.hoisted(() => ({
  registerAisCallback: vi.fn<(callback: (data: AisPositionData) => void) => void>(),
  unregisterAisCallback: vi.fn(),
  isAisConfigured: vi.fn(() => false),
  initAisStream: vi.fn(),
}));
const fetchReport = vi.hoisted(() => vi.fn<() => Promise<USNIFleetReport | null>>());

vi.mock('@/services/maritime', () => stream);
vi.mock('@/utils', () => import('@/utils/circuit-breaker'));
vi.mock('@/services/usni-fleet', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/usni-fleet')>(),
  fetchUSNIFleetReport: fetchReport,
}));

let service: typeof import('@/services/military-vessels');
let receive: (data: AisPositionData) => void;
let now: number;
const LIMIT = 500;

function position(index: number, overrides: Partial<AisPositionData> = {}): AisPositionData {
  return {
    mmsi: String(300100000 + index), name: 'TEST PATROL', shipType: 35,
    lat: -40, lon: -140, ...overrides,
  };
}

function send(index: number, overrides: Partial<AisPositionData> = {}): void {
  now++;
  receive(position(index, overrides));
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  stream.registerAisCallback.mockClear();
  fetchReport.mockReset().mockResolvedValue(null);
  now = Date.parse('2026-09-06T12:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  service = await import('@/services/military-vessels');
  service.initMilitaryVesselStream();
  const callback = stream.registerAisCallback.mock.calls[0]?.[0];
  if (!callback) throw new Error('Military vessel stream did not register its AIS callback');
  receive = callback;
});

afterEach(() => {
  service.disconnectMilitaryVesselStream();
  service.stopVesselHistoryCleanup();
  localStorage.clear();
});

describe('military vessel feed retention', () => {
  it('bounds every insertion in the reported 1,473-vessel case and returns the newest ordinary vessels', async () => {
    for (let i = 0; i < 1473; i++) {
      send(i);
      expect(service.getMilitaryVesselStatus().vessels).toBeLessThanOrEqual(LIMIT);
    }
    const data = await service.fetchMilitaryVessels();
    expect(data.vessels).toHaveLength(LIMIT);
    expect(new Set(data.vessels.map(v => v.mmsi))).toEqual(
      new Set(Array.from({ length: LIMIT }, (_, i) => position(973 + i).mmsi)),
    );
    expect(service.getVesselByMmsi(position(0).mmsi)).toBeUndefined();
    expect(service.getVesselsNearLocation(-40, -140)).toHaveLength(LIMIT);
    expect((await service.fetchMilitaryVessels()).vessels).toHaveLength(LIMIT);
    expect(fetchReport).toHaveBeenCalledTimes(1);
  });

  it('keeps carriers, dark returns and unusual positions ahead of newer ordinary vessels', async () => {
    send(1);
    now += 61 * 60 * 1000;
    send(1); // Real AIS gap detection marks this return as dark.
    send(2, { name: 'USS Nimitz' });
    send(3, { lat: 26.5, lon: 56.5 });
    for (let i = 4; i < LIMIT + 20; i++) send(i);

    const data = await service.fetchMilitaryVessels();
    expect(data.vessels).toHaveLength(LIMIT);
    expect(service.getVesselByMmsi(position(1).mmsi)?.isDark).toBe(true);
    expect(service.getDarkVessels().map(v => v.mmsi)).toContain(position(1).mmsi);
    expect(service.getVesselByMmsi(position(2).mmsi)?.vesselType).toBe('carrier');
    expect(service.getVesselByMmsi(position(3).mmsi)?.isInteresting).toBe(true);
    expect(service.getVesselByMmsi(position(4).mmsi)).toBeUndefined();
  });

  it('uses a stable MMSI tie break when reports arrive at the same time', () => {
    for (let i = LIMIT; i >= 0; i--) receive(position(i));
    expect(service.getMilitaryVesselStatus().vessels).toBe(LIMIT);
    expect(service.getVesselByMmsi(position(0).mmsi)).toBeDefined();
    expect(service.getVesselByMmsi(position(LIMIT).mmsi)).toBeUndefined();
  });

  it('rejects lower-priority arrivals when full and still bounds an all-carrier feed', () => {
    for (let i = 0; i < LIMIT; i++) send(i, { name: 'USS Nimitz' });
    send(LIMIT, { lat: 26.5, lon: 56.5 });
    expect(service.getVesselByMmsi(position(LIMIT).mmsi)).toBeUndefined();
    send(LIMIT + 1, { name: 'USS Carl Vinson' });
    expect(service.getMilitaryVesselStatus().vessels).toBe(LIMIT);
    expect(service.getVesselByMmsi(position(0).mmsi)).toBeUndefined();
    expect(service.getVesselByMmsi(position(LIMIT + 1).mmsi)?.vesselType).toBe('carrier');

    now += 61 * 60 * 1000;
    send(LIMIT);
    expect(service.getVesselByMmsi(position(LIMIT).mmsi)?.track).toBeUndefined();
  });

  it('deletes evicted trails, preserves retained updates and caps each trail at 30 points', () => {
    send(0);
    send(0, { lat: -41 });
    expect(service.getVesselByMmsi(position(0).mmsi)?.track).toHaveLength(2);
    for (let i = 1; i <= LIMIT; i++) send(i);
    expect(service.getVesselByMmsi(position(0).mmsi)).toBeUndefined();
    send(0);
    expect(service.getVesselByMmsi(position(0).mmsi)?.track).toBeUndefined();
    for (let i = 0; i < 40; i++) send(0, { lat: -41 });
    expect(service.getVesselByMmsi(position(0).mmsi)?.track).toHaveLength(30);
    expect(service.getMilitaryVesselStatus().vessels).toBe(LIMIT);
  });

  it('expires stale priority vessels before evicting fresh ordinary vessels', async () => {
    send(0, { name: 'USS Nimitz' });
    now += 61 * 60 * 1000;
    for (let i = 1; i <= LIMIT; i++) send(i);
    expect(service.getVesselByMmsi(position(0).mmsi)).toBeUndefined();
    expect(service.getMilitaryVesselStatus().vessels).toBe(LIMIT);
    now += 61 * 60 * 1000;
    expect((await service.fetchMilitaryVessels()).vessels).toHaveLength(0);
  });

  it('caps the real USNI merge and keeps cluster membership, counts and centers consistent', async () => {
    for (let i = 0; i < LIMIT; i++) send(i, { lat: 28 + i / 1000, lon: 125 });
    const articleDate = new Date(now - 3600_000).toISOString();
    fetchReport.mockResolvedValue({
      articleUrl: 'https://news.usni.org/test', articleDate, articleTitle: 'Test fleet report',
      timestamp: articleDate, strikeGroups: [], regions: ['Western Pacific'], parsingWarnings: [],
      vessels: ['USS Nimitz', 'USS Carl Vinson'].map((name, i) => ({
        name, hullNumber: `CVN-${68 + i * 2}`, vesselType: 'carrier', region: 'Western Pacific',
        regionLat: 28, regionLon: 125, deploymentStatus: 'deployed', strikeGroup: 'Test group',
        usniArticleUrl: 'https://news.usni.org/test', usniArticleDate: articleDate,
      })),
    });

    const data = await service.fetchMilitaryVessels();
    expect(data.vessels).toHaveLength(LIMIT);
    expect(data.vessels.filter(v => v.usniSource)).toHaveLength(2);
    const byId = new Map(data.vessels.map(v => [v.id, v]));
    expect(data.clusters.length).toBeGreaterThanOrEqual(2);
    for (const cluster of data.clusters) {
      expect(cluster.vesselCount).toBe(cluster.vessels.length);
      expect(cluster.vesselCount).toBeGreaterThanOrEqual(2);
      expect(cluster.lat).toBeCloseTo(cluster.vessels.reduce((sum, v) => sum + v.lat, 0) / cluster.vesselCount);
      expect(cluster.lon).toBeCloseTo(cluster.vessels.reduce((sum, v) => sum + v.lon, 0) / cluster.vesselCount);
      for (const vessel of cluster.vessels) expect(vessel).toBe(byId.get(vessel.id));
    }
  });

  it('returns the bounded AIS set when USNI fails and leaves small feeds complete', async () => {
    send(0);
    send(1);
    fetchReport.mockRejectedValue(new Error('USNI unavailable'));
    expect((await service.fetchMilitaryVessels()).vessels).toHaveLength(2);
    for (let i = 2; i < 1473; i++) send(i);
    service.disconnectMilitaryVesselStream();
    service.initMilitaryVesselStream();
    expect((await service.fetchMilitaryVessels()).vessels).toHaveLength(LIMIT);
  });

  it('bounds an older persisted payload and drops clusters with fewer than two retained members', async () => {
    const vessels = Array.from({ length: 1473 }, (_, i): MilitaryVessel => ({
      ...position(i), id: `ais-${position(i).mmsi}`, vesselType: 'destroyer',
      operator: 'other', operatorCountry: 'Unknown', heading: 0, speed: 0,
      lastAisUpdate: new Date(now + i), confidence: 'low', isInteresting: false,
    }));
    const cluster = (id: string, members: MilitaryVessel[]) => ({
      id, name: id, lat: -40, lon: -140, vesselCount: members.length, vessels: members,
    });
    const key = 'breaker:Military Vessel Tracking';
    localStorage.setItem(`worldmonitor-persistent-cache:${key}`, JSON.stringify({
      key, updatedAt: now, data: { vessels, clusters: [
        cluster('retained', vessels),
        cluster('removed', vessels.slice(0, 2)),
        cluster('singleton', [...vessels.slice(0, 1), ...vessels.slice(-1)]),
      ] },
    }));

    const data = await service.fetchMilitaryVessels();
    expect(fetchReport).not.toHaveBeenCalled();
    expect(data.vessels).toHaveLength(LIMIT);
    expect(data.vessels[0]?.mmsi).toBe(position(1472).mmsi);
    expect(data.vessels.every(v => v.lastAisUpdate instanceof Date)).toBe(true);
    expect(data.clusters.map(c => c.id)).toEqual(['retained']);
    expect(data.clusters[0]?.vesselCount).toBe(LIMIT);
    expect(data.clusters[0]?.vessels.every(v => data.vessels.includes(v))).toBe(true);
  });
});
