// Runtime proof that the relay classifies tankers from ShipStaticData (#8690,
// replacing the source-text checks this file used to hold).
//
// Background: AISStream PositionReport frames carry no ShipType, so a relay
// that classified from `meta.ShipType` alone never captured a tanker (#3402).
// The fix caches ShipType and ShipName per MMSI from ShipStaticData (AIS Type
// 5) and resolves each PositionReport through that cache.
//
// scripts/ais-relay.cjs starts servers on import, so the vessel-aggregate
// region is evaluated in a vm context with its outer constants and the
// chokepoint/transit collaborators stubbed; the functions under test and the
// Maps they write are read back from that context. One text check stays, with
// its reason: the AISStream subscription message is a wire contract sent to a
// third party, and the WebSocket handler that dispatches on MessageType cannot
// be evaluated without a live socket.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';

const RELAY = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

function vesselRegion() {
  const start = RELAY.indexOf('const MAX_VESSEL_META = 50000;');
  const cleanup = RELAY.indexOf('function cleanupAggregates()');
  const end = RELAY.indexOf('\nfunction ', cleanup + 10);
  assert.ok(start > -1 && cleanup > start && end > cleanup, 'vessel aggregate region markers must exist in scripts/ais-relay.cjs');
  return RELAY.slice(start, end);
}

function harness({ now = 1_700_000_000_000 } = {}) {
  const clock = { now };
  const api = runInNewContext(`${vesselRegion()}\n({ processShipStaticDataForMeta, processPositionReportForSnapshot, cleanupAggregates, vesselMeta, tankerReports, candidateReports, vessels, VESSEL_META_TTL_MS, MAX_VESSEL_META })`, {
    console: { log() {}, warn() {}, error() {} },
    Date: { now: () => clock.now },
    Math, Number, String, Map, Set, Array, JSON, Object,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    createDurableTransitTracker: () => ({ observe() {}, prune() {} }),
    CHOKEPOINT_TRANSIT_GATES: [],
    upstashEval: async () => null,
    classifyVesselType: () => 'other',
    GRID_SIZE: 1,
    DENSITY_WINDOW: 30 * 60 * 1000,
    GAP_THRESHOLD: 60 * 60 * 1000,
    MAX_VESSELS: 10_000,
    MAX_VESSEL_HISTORY: 10_000,
    MAX_DENSITY_CELLS: 10_000,
    MAX_CANDIDATE_REPORTS: 10_000,
    CANDIDATE_RETENTION_MS: 30 * 60 * 1000,
    MAX_TANKER_REPORTS_PER_RESPONSE: 10_000,
  });
  return { ...api, clock };
}

const staticFrame = (mmsi, type, extra = {}) => ({
  MetaData: { MMSI: mmsi, ShipName: 'META NAME' },
  Message: { ShipStaticData: { Type: type, Name: 'STATIC NAME', ...extra } },
});
const positionFrame = (mmsi, meta = {}) => ({
  MetaData: { MMSI: mmsi, ShipName: '', latitude: 25.2, longitude: 55.3, ...meta },
  Message: { PositionReport: { Latitude: 25.2, Longitude: 55.3, TrueHeading: 90, Sog: 12, Cog: 91 } },
});

describe('ShipStaticData meta cache', () => {
  it('caches ShipType and name per MMSI from the message body', () => {
    const h = harness();
    assert.equal(h.processShipStaticDataForMeta(staticFrame('211123401', 85)), true);
    assert.deepEqual({ ...h.vesselMeta.get('211123401') }, { shipType: 85, shipName: 'STATIC NAME', lastSeen: h.clock.now });
  });

  it('falls back to the body UserID when the wrapper carries no MMSI', () => {
    const h = harness();
    const frame = { MetaData: {}, Message: { ShipStaticData: { Type: 80, UserID: 211123402 } } };
    assert.equal(h.processShipStaticDataForMeta(frame), true);
    assert.equal(h.vesselMeta.get('211123402')?.shipType, 80);
    assert.equal(h.processShipStaticDataForMeta({ MetaData: {}, Message: { ShipStaticData: { Type: 80 } } }), false);
  });

  it('rejects "not available" and malformed types without downgrading a cached tanker', () => {
    const h = harness();
    h.processShipStaticDataForMeta(staticFrame('211123403', 85));
    for (const type of [0, -1, null, undefined, 'tanker', Number.NaN]) {
      assert.equal(h.processShipStaticDataForMeta(staticFrame('211123403', type)), false, `type ${String(type)}`);
    }
    assert.equal(h.vesselMeta.get('211123403')?.shipType, 85);
    assert.equal(h.processShipStaticDataForMeta({ MetaData: { MMSI: '1' }, Message: {} }), false);
  });
});

describe('PositionReport classification through the cache', () => {
  it('captures a tanker whose position report carries no ShipType once static data was seen', () => {
    const h = harness();
    h.processShipStaticDataForMeta(staticFrame('211123410', 85));
    assert.equal(h.processPositionReportForSnapshot(positionFrame('211123410')), true);
    const tanker = h.tankerReports.get('211123410');
    assert.ok(tanker, 'the tanker layer must receive the vessel');
    assert.equal(tanker.shipType, 85);
    assert.equal(tanker.name, 'STATIC NAME', 'the cached static name fills an empty position-report name');
    assert.equal(h.vessels.get('211123410')?.shipType, 85, 'the vessels record carries the resolved type too');
  });

  it('captures nothing for an uncached vessel and does not invent a type', () => {
    const h = harness();
    assert.equal(h.processPositionReportForSnapshot(positionFrame('211123411')), true);
    assert.equal(h.tankerReports.has('211123411'), false);
    assert.equal(h.vessels.get('211123411')?.shipType, undefined);
  });

  it('updates a tracked tanker when another position report arrives', () => {
    const h = harness();
    const mmsi = '211123416';
    h.processShipStaticDataForMeta(staticFrame(mmsi, 85));
    assert.equal(h.processPositionReportForSnapshot(positionFrame(mmsi)), true);

    h.clock.now += 60_000;
    const next = positionFrame(mmsi);
    next.Message.PositionReport.Longitude = 55.4;
    assert.equal(h.processPositionReportForSnapshot(next), true);
    const tanker = h.tankerReports.get(mmsi);
    assert.equal(tanker.shipType, 85);
    assert.equal(tanker.name, 'STATIC NAME');
    assert.equal(tanker.lon, 55.4);
    assert.equal(tanker.timestamp, h.clock.now);
    assert.equal(h.tankerReports.size, 1);
  });

  it('keeps non-tanker types out of the tanker layer and lets wrapper ShipType win over the cache', () => {
    const h = harness();
    h.processShipStaticDataForMeta(staticFrame('211123412', 70));
    h.processPositionReportForSnapshot(positionFrame('211123412'));
    assert.equal(h.tankerReports.has('211123412'), false, 'cargo (70) is not a tanker');
    assert.equal(h.vessels.get('211123412')?.shipType, 70);

    h.processShipStaticDataForMeta(staticFrame('211123413', 70));
    h.processPositionReportForSnapshot(positionFrame('211123413', { ShipType: 89 }));
    assert.equal(h.tankerReports.get('211123413')?.shipType, 89, 'an explicit wrapper type is authoritative');
  });

  it('feeds the resolved type into the military-candidate arm', () => {
    const h = harness();
    h.processShipStaticDataForMeta(staticFrame('211123414', 35));
    h.processPositionReportForSnapshot(positionFrame('211123414'));
    assert.equal(h.candidateReports.get('211123414')?.shipType, 35, 'type 35 (military ops) must be a candidate from the cache alone');
    h.processPositionReportForSnapshot(positionFrame('211123415'));
    assert.equal(h.candidateReports.has('211123415'), false);
  });
});

describe('vesselMeta retention', () => {
  it('drops entries past the TTL and keeps fresh ones', () => {
    const h = harness();
    h.processShipStaticDataForMeta(staticFrame('211123420', 85));
    h.clock.now += h.VESSEL_META_TTL_MS + 1;
    h.processShipStaticDataForMeta(staticFrame('211123421', 85));
    h.cleanupAggregates();
    assert.equal(h.vesselMeta.has('211123420'), false, 'expired static data is evicted');
    assert.equal(h.vesselMeta.has('211123421'), true);
  });

  it('caps the cache by evicting the oldest entries, so a flood of MMSIs cannot grow it unbounded', () => {
    const h = harness();
    for (let i = 0; i < h.MAX_VESSEL_META + 5; i += 1) {
      h.clock.now += 1;
      h.processShipStaticDataForMeta(staticFrame(String(300123000 + i), 80));
    }
    h.cleanupAggregates();
    assert.equal(h.vesselMeta.size, h.MAX_VESSEL_META);
    assert.equal(h.vesselMeta.has('300123000'), false, 'the oldest entry goes first');
    assert.equal(h.vesselMeta.has(String(300123000 + h.MAX_VESSEL_META + 4)), true);
  });
});

describe('AISStream wire contract (text, see header)', () => {
  it('subscribes to PositionReport and ShipStaticData and dispatches static frames to the cache', () => {
    assert.match(RELAY, /FilterMessageTypes:\s*\[\s*['"]PositionReport['"]\s*,\s*['"]ShipStaticData['"]\s*\]/);
    assert.match(RELAY, /MessageType\s*===\s*['"]ShipStaticData['"][\s\S]{0,400}processShipStaticDataForMeta\(parsed\)/);
  });
});
