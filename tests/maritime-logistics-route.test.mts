import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_MARITIME_FOCUS,
  MARITIME_FOCUS_AREAS,
  isMaritimeLogisticsPath,
  maritimeFocusArea,
  maritimeLogisticsUrl,
  selectVerifiedAisReports,
} from '../src/features/maritime-logistics/maritime-logistics-route.ts';

const workspaceSource = readFileSync(
  new URL('../src/features/maritime-logistics/maritime-logistics.ts', import.meta.url),
  'utf8',
);

test('maritime logistics owns only its native route', () => {
  assert.equal(isMaritimeLogisticsPath('/maritime-logistics'), true);
  assert.equal(isMaritimeLogisticsPath('/maritime-logistics/'), true);
  assert.equal(isMaritimeLogisticsPath('/shipping'), false);
  assert.equal(isMaritimeLogisticsPath('/maritime-logistics/extra'), false);
});

test('premium route intelligence uses the authenticated premium fetch boundary', () => {
  assert.match(workspaceSource, /import \{ premiumFetch \} from '@\/services\/premium-fetch'/);
  assert.match(
    workspaceSource,
    /new ShippingV2ServiceClient\(getRpcBaseUrl\(\), \{ fetch: premiumFetch \}\)/,
  );
  assert.doesNotMatch(
    workspaceSource,
    /new ShippingV2ServiceClient\(getRpcBaseUrl\(\), \{ fetch: rpcFetch \}\)/,
  );
});

test('each selectable AIS focus remains inside the server bbox cap', () => {
  for (const area of MARITIME_FOCUS_AREAS) {
    assert.ok(area.neLat - area.swLat <= 10, `${area.id} latitude span must stay bounded`);
    assert.ok(area.neLon - area.swLon <= 10, `${area.id} longitude span must stay bounded`);
    assert.ok(area.swLat >= -90 && area.neLat <= 90, `${area.id} latitude domain`);
    assert.ok(area.swLon >= -180 && area.neLon <= 180, `${area.id} longitude domain`);
  }
  assert.equal(maritimeFocusArea('not-a-focus').id, DEFAULT_MARITIME_FOCUS);
  assert.equal(maritimeLogisticsUrl('suez'), '/maritime-logistics?focus=suez');
});

test('vessel admission rejects out-of-bbox, malformed and stale-identity reports instead of reusing a global subset', () => {
  const focus = maritimeFocusArea('suez');
  const reports = selectVerifiedAisReports([
    { mmsi: '123456789', lat: 30, lon: 33, timestamp: 1000, name: 'older' },
    { mmsi: '123456789', lat: 30.2, lon: 33.2, timestamp: 2000, name: 'newest' },
    { mmsi: '987654321', lat: 65, lon: -20, timestamp: 3000, name: 'other-region' },
    { mmsi: 'bad', lat: 30, lon: 33, timestamp: 4000, name: 'bad-mmsi' },
    { mmsi: '111111111', lat: 30, lon: 33, timestamp: 0, name: 'missing-time' },
  ], focus);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.mmsi, '123456789');
  assert.equal(reports[0]?.timestamp, 2000);
  assert.equal(reports[0]?.name, 'newest');
});
