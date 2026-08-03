import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import type { ClusteredEvent } from '../src/types/index.ts';
import {
  hydrateGeoHubPanelFromClusters,
  hydrateTechHubPanelFromClusters,
} from '../src/app/hub-activity-hydration.ts';

const geoCluster: ClusteredEvent = {
  id: 'geo-cluster-1',
  primaryTitle: 'Moscow officials announce a new security operation',
  primarySource: 'Test source',
  primaryLink: 'https://example.com/story',
  sourceCount: 1,
  topSources: [],
  allItems: [],
  firstSeen: new Date('2026-08-03T00:00:00Z'),
  lastUpdated: new Date('2026-08-03T01:00:00Z'),
  isAlert: false,
  velocity: {
    sourcesPerHour: 3,
    level: 'elevated',
    trend: 'rising',
    sentiment: 'neutral',
    sentimentScore: 0,
  },
};

const techCluster: ClusteredEvent = {
  ...geoCluster,
  id: 'tech-cluster-1',
  primaryTitle: 'OpenAI expands its San Francisco operation',
};

describe('late-mounted hub activity hydration', () => {
  it('hydrates a geopolitical hub panel from retained clusters', () => {
    let activities: unknown[] | undefined;

    hydrateGeoHubPanelFromClusters({
      setActivities: (next) => { activities = next; },
    }, [geoCluster]);

    assert.ok(activities);
    assert.ok(activities.length > 0);
    assert.equal((activities[0] as { name: string }).name, 'Moscow');
  });

  it('hydrates a tech hub panel through the deferred tech activity import', async () => {
    let activities: unknown[] | undefined;

    await hydrateTechHubPanelFromClusters({
      setActivities: (next) => { activities = next; },
    }, [techCluster]);

    assert.ok(activities);
    assert.ok(activities.length > 0);
    assert.equal((activities[0] as { city: string }).city, 'San Francisco');
  });

  it('does not paint an empty state before clustering has produced data', async () => {
    let geoCalls = 0;
    let techCalls = 0;

    hydrateGeoHubPanelFromClusters({ setActivities: () => { geoCalls++; } }, []);
    await hydrateTechHubPanelFromClusters({ setActivities: () => { techCalls++; } }, []);

    assert.equal(geoCalls, 0);
    assert.equal(techCalls, 0);
  });

  it('clears the loading state when completed clustering has no matches', async () => {
    let geoActivities: unknown[] | undefined;
    let techActivities: unknown[] | undefined;

    hydrateGeoHubPanelFromClusters({ setActivities: (next) => { geoActivities = next; } }, [], { allowEmpty: true });
    await hydrateTechHubPanelFromClusters({ setActivities: (next) => { techActivities = next; } }, [], { allowEmpty: true });

    assert.deepEqual(geoActivities, []);
    assert.deepEqual(techActivities, []);
  });

  it('runs the retained-cluster backfill from both lazy panel factories', async () => {
    const source = await readFile(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');

    assert.match(
      source,
      /hydrateGeoHubPanelFromClusters\(p,\s*this\.ctx\.latestClusters,\s*\{\s*allowEmpty:/,
      'GeoHubsPanel factory must backfill retained clusters after a late mount',
    );
    assert.match(
      source,
      /hydrateTechHubPanelFromClusters\(p,\s*this\.ctx\.latestClusters,\s*\{\s*allowEmpty:/,
      'TechHubsPanel factory must backfill retained clusters after a late mount',
    );
  });
});
