import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHistory } from '../scripts/seed-portwatch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/portwatch-arcgis-sample.json'), 'utf-8'));

const ARCGIS_FIELDS_USED_BY_BUILD_HISTORY = [
  'date',
  'n_container',
  'n_dry_bulk',
  'n_general_cargo',
  'n_roro',
  'n_tanker',
  'n_total',
  'capacity_container',
  'capacity_dry_bulk',
  'capacity_general_cargo',
  'capacity_roro',
  'capacity_tanker',
];

describe('PortWatch ArcGIS fixture matches upstream shape', () => {
  it('has features array', () => {
    assert.ok(Array.isArray(fixture.features));
    assert.ok(fixture.features.length > 0);
  });

  it('has exceededTransferLimit field', () => {
    assert.ok('exceededTransferLimit' in fixture);
  });

  it('each feature has all attributes used by buildHistory', () => {
    for (const feature of fixture.features) {
      assert.ok(feature.attributes, 'feature must have attributes');
      for (const field of ARCGIS_FIELDS_USED_BY_BUILD_HISTORY) {
        assert.ok(field in feature.attributes, `missing attribute: ${field}`);
      }
    }
  });
});

describe('PortWatch fixture parsed through buildHistory', () => {
  const history = buildHistory(fixture.features);

  it('produces correct number of entries', () => {
    assert.equal(history.length, fixture.features.length);
  });

  it('entries are sorted by date ascending', () => {
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i].date >= history[i - 1].date, 'dates must be ascending');
    }
  });

  it('each entry has all required output fields', () => {
    const requiredFields = [
      'date', 'container', 'dryBulk', 'generalCargo', 'roro', 'tanker',
      'cargo', 'other', 'total',
      'capContainer', 'capDryBulk', 'capGeneralCargo', 'capRoro', 'capTanker',
    ];
    for (const entry of history) {
      for (const field of requiredFields) {
        assert.ok(field in entry, `missing field: ${field}`);
      }
    }
  });

  it('cargo is sum of container + dryBulk + generalCargo + roro', () => {
    for (const entry of history) {
      assert.equal(entry.cargo, entry.container + entry.dryBulk + entry.generalCargo + entry.roro);
    }
  });

  it('first entry has expected values from fixture', () => {
    const first = history[0];
    assert.equal(first.container, 12);
    assert.equal(first.dryBulk, 8);
    assert.equal(first.generalCargo, 5);
    assert.equal(first.roro, 2);
    assert.equal(first.tanker, 15);
    assert.equal(first.total, 42);
    assert.equal(first.capContainer, 450000);
    assert.equal(first.capDryBulk, 320000);
    assert.equal(first.capGeneralCargo, 100000);
    assert.equal(first.capRoro, 60000);
    assert.equal(first.capTanker, 1200000);
  });

  it('capacity fields are numeric', () => {
    for (const entry of history) {
      assert.equal(typeof entry.capContainer, 'number');
      assert.equal(typeof entry.capDryBulk, 'number');
      assert.equal(typeof entry.capGeneralCargo, 'number');
      assert.equal(typeof entry.capRoro, 'number');
      assert.equal(typeof entry.capTanker, 'number');
    }
  });
});
