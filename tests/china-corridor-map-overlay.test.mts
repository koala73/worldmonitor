import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHINA_LOGISTICS_CORRIDORS } from '../shared/china-logistics-corridors.ts';
import { projectChinaCorridorOverlay } from '../src/components/map/china-corridor-overlay.ts';

describe('China corridor map overlay (#5578)', () => {
  it('projects the reviewed boundary and nodes without free-text geocoding', () => {
    const definition = CHINA_LOGISTICS_CORRIDORS[0]!;
    const projection = projectChinaCorridorOverlay({
      ...definition,
      availability: 'partial',
      conditions: [],
    });

    assert.equal(projection.id, 'china-yangtze-river-delta');
    assert.equal(projection.polygon.length, definition.boundary.length);
    assert.deepEqual(projection.polygon[0], [definition.boundary[0]!.lon, definition.boundary[0]!.lat]);
    assert.equal(projection.nodes.length, definition.nodes.length);
    assert.equal(projection.nodes.every((node) => Number.isFinite(node.position[0]) && Number.isFinite(node.position[1])), true);
    assert.equal(projection.center.lon >= projection.bounds[0] && projection.center.lon <= projection.bounds[2], true);
    assert.equal(projection.center.lat >= projection.bounds[1] && projection.center.lat <= projection.bounds[3], true);
  });
});
