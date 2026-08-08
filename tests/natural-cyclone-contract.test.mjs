import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

describe('natural cyclone attribution contract', () => {
  it('ships canonical identity and agency-level wind-period observations through the proto bindings', () => {
    const proto = read('proto/worldmonitor/natural/v1/list_natural_events.proto');
    const client = read('src/generated/client/worldmonitor/natural/v1/service_client.ts');
    const types = read('src/types/index.ts');
    const adapter = read('src/services/eonet.ts');

    assert.match(proto, /message CycloneAgencyObservation \{/);
    assert.match(proto, /optional string canonical_id = 26/);
    assert.match(proto, /optional string matching_confidence = 27/);
    assert.match(proto, /optional int32 wind_averaging_period_minutes = 29/);
    assert.match(proto, /repeated CycloneAgencyObservation agency_observations = 30/);
    assert.match(client, /agencyObservations: CycloneAgencyObservation\[\]/);
    assert.match(types, /export interface CycloneAgencyObservation/);
    assert.match(types, /windAveragingPeriodMinutes\?: number/);
    assert.match(adapter, /canonicalId: e\.canonicalId \|\| undefined/);
    assert.match(adapter, /agencyObservations: e\.agencyObservations\?\.length \? e\.agencyObservations : undefined/);
  });

  it('renders source attribution, confidence, and wind averaging periods in the natural-event detail surface', () => {
    const popup = read('src/components/MapPopup.ts');
    assert.match(popup, /Canonical match/);
    assert.match(popup, /Wind average/);
    assert.match(popup, /Agency observations/);
    assert.match(popup, /event\.agencyObservations/);
    assert.match(popup, /event\.agencyObservations\?\.length \? this\.renderTcDetails/);
  });
});
