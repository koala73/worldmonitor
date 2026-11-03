/**
 * AIS ship type 35 ("Military Ops") is a generic activity code, not a vessel
 * class (#8611). `getVesselTypeFromAis` used to return `destroyer` for it, so
 * any unidentified ship broadcasting 35 was labelled Destroyer in the popup,
 * counted as a destroyer by `StrategicPosturePanel`, and exported as one.
 *
 * The fix must keep three things that the naive "return undefined" fix breaks:
 *  - type 35 still qualifies the vessel as military, so it stays tracked even
 *    when the MMSI and name carry no military signal at all;
 *  - the supported "Military Ops" fact still reaches every label surface, not
 *    just a bare "unknown";
 *  - a known-vessel name override still wins, so real destroyers stay
 *    destroyers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AisPositionData } from '@/services/maritime';
import type { USNIFleetReport } from '@/types';

const stream = vi.hoisted(() => ({
  registerAisCallback: vi.fn<(callback: (data: AisPositionData) => void) => void>(),
  unregisterAisCallback: vi.fn(),
  isAisConfigured: vi.fn(() => false),
  initAisStream: vi.fn(),
}));
const fetchReport = vi.hoisted(() => vi.fn<() => Promise<USNIFleetReport | null>>());

const persisted = vi.hoisted(() => ({ entry: null as unknown }));
vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: async () => persisted.entry,
  setPersistentCache: async () => {},
  deletePersistentCache: async () => {},
}));

vi.mock('@/services/maritime', () => stream);
vi.mock('@/utils', () => import('@/utils/circuit-breaker'));
vi.mock('@/services/usni-fleet', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/usni-fleet')>(),
  fetchUSNIFleetReport: fetchReport,
}));

// A civil MMSI: no MILITARY_VESSEL_PATTERNS prefix and no 00/99 suffix, so
// analyzeMmsi reports isPotentialMilitary: false. Tracking therefore depends
// entirely on the AIS ship type.
const CIVIL_MMSI = '235123456';

let service: typeof import('@/services/military-vessels');
let receive: (data: AisPositionData) => void;

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  persisted.entry = null;
  stream.registerAisCallback.mockClear();
  fetchReport.mockReset().mockResolvedValue(null);
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

describe('AIS military-ops classification', () => {
  it('does not claim a vessel class for a generic type 35 report', () => {
    receive({ mmsi: CIVIL_MMSI, name: 'SEA FALCON', shipType: 35, lat: 12, lon: 44 });

    const vessel = service.getVesselByMmsi(CIVIL_MMSI);
    expect(vessel).toBeDefined();
    expect(vessel?.vesselType).not.toBe('destroyer');
    expect(vessel?.vesselType).toBe('unknown');
    expect(vessel?.aisShipType).toBe('Military Ops');
    expect(vessel?.confidence).toBe('low');
  });

  it('keeps a known-vessel name override ahead of the AIS code', () => {
    receive({ mmsi: CIVIL_MMSI, name: 'USS ZUMWALT', shipType: 35, lat: 12, lon: 44 });

    const vessel = service.getVesselByMmsi(CIVIL_MMSI);
    expect(vessel?.vesselType).toBe('destroyer');
    expect(vessel?.hullNumber).toBe('DDG-1000');
    expect(vessel?.confidence).toBe('high');
  });

  it('leaves the non-military AIS mappings unchanged', () => {
    receive({ mmsi: '235123401', name: 'COAST PATROL', shipType: 55, lat: 12, lon: 44 });
    receive({ mmsi: '235123402', name: 'PORT TUG', shipType: 52, lat: 12, lon: 44 });
    receive({ mmsi: '235123403', name: 'BOX MOVER', shipType: 70, lat: 12, lon: 44 });

    expect(service.getVesselByMmsi('235123401')?.vesselType).toBe('patrol');
    expect(service.getVesselByMmsi('235123402')?.vesselType).toBe('special');
    expect(service.getVesselByMmsi('235123403')).toBeUndefined();
  });
});

describe('rehydrated pre-fix snapshots', () => {
  // Snapshots persist for up to 24 h, so shipping the classifier fix alone
  // would leave a returning user staring at the same wrong Destroyer label
  // until their cache aged out.
  it('drops the stale destroyer claim from an AIS-only Military Ops record', async () => {
    persisted.entry = {
      data: {
        vessels: [{
          id: 'ais-235123456', mmsi: '235123456', name: 'SEA FALCON',
          vesselType: 'destroyer', aisShipType: 'Military Ops',
          operator: 'other', operatorCountry: 'Yemen',
          lat: 12, lon: 44, heading: 0, speed: 4,
          lastAisUpdate: new Date().toISOString(), confidence: 'low',
        }],
        clusters: [],
      },
      timestamp: Date.now(),
    };

    const { vessels } = await service.fetchMilitaryVessels();
    const revived = vessels.find(v => v.mmsi === '235123456');
    expect(revived?.vesselType).toBe('unknown');
    expect(revived?.aisShipType).toBe('Military Ops');
  });

  it('keeps a real destroyer that carries a hull number', async () => {
    persisted.entry = {
      data: {
        vessels: [{
          id: 'ais-235123457', mmsi: '235123457', name: 'USS ZUMWALT',
          vesselType: 'destroyer', hullNumber: 'DDG-1000', aisShipType: 'Military Ops',
          operator: 'usn', operatorCountry: 'USA',
          lat: 12, lon: 44, heading: 0, speed: 4,
          lastAisUpdate: new Date().toISOString(), confidence: 'high',
        }],
        clusters: [],
      },
      timestamp: Date.now(),
    };

    const { vessels } = await service.fetchMilitaryVessels();
    expect(vessels.find(v => v.mmsi === '235123457')?.vesselType).toBe('destroyer');
  });
});
