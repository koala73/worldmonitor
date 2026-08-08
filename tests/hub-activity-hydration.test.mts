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

  it('lets the newest tech hydration win when an older one is still importing', async () => {
    const writes: unknown[][] = [];
    const panel = { setActivities: (next: unknown[]) => { writes.push(next); } };

    // Issued first with data, resolves last (it crosses the dynamic import);
    // the empty paint issued second must not be undone by it.
    const stale = hydrateTechHubPanelFromClusters(panel, [techCluster]);
    const fresh = hydrateTechHubPanelFromClusters(panel, [], { allowEmpty: true });
    await Promise.all([stale, fresh]);

    assert.equal(writes.length, 1, 'a superseded hydration must not paint');
    assert.deepEqual(writes[0], [], 'the newest hydration must be the one that lands');
  });
});

// panel-layout.ts cannot be imported by the plain-Node test harness (Vite-only
// resolution, and no live PanelLayoutManager is mountable today — #5892), so the
// factory wiring is guarded at the source level. Per the prevention note in
// docs/solutions/performance-issues/desktop-cls-immediate-tier-panel-mounts-need-deferred-shells.md,
// slice the owning factory FIRST and assert against that body: a whole-file match
// would pass with the geo call wired into the tech factory, or with the option
// value mutated.
function extractLazyPanelFactory(source: string, panelKey: string): string {
  const match = source.match(
    new RegExp(`this\\.lazyImportedPanel\\('${panelKey}'[\\s\\S]*?\\n {4}\\}\\);`),
  );
  assert.ok(match, `could not locate the '${panelKey}' lazyImportedPanel factory in panel-layout.ts`);
  return match[0];
}

describe('late-mounted hub activity wiring', () => {
  it('gates the geo-hubs factory backfill on clustersSettled', async () => {
    const source = await readFile(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');
    const factory = extractLazyPanelFactory(source, 'geo-hubs');

    assert.match(
      factory,
      /hydrateGeoHubPanelFromClusters\(p,\s*this\.ctx\.latestClusters,\s*\{\s*allowEmpty:\s*this\.ctx\.clustersSettled,?\s*\}\)/,
      'GeoHubsPanel factory must backfill retained clusters, gated on clustersSettled',
    );
    assert.doesNotMatch(
      factory,
      /allowEmpty:\s*(?:true|false|this\.ctx\.initialLoadComplete)\b/,
      'allowEmpty must not be hardcoded or keyed on initialLoadComplete, which is true before clustering starts',
    );
    assert.doesNotMatch(factory, /hydrateTechHubPanelFromClusters/, 'geo factory must not hydrate the tech panel');
  });

  it('gates the tech-hubs factory backfill on clustersSettled and logs import failures', async () => {
    const source = await readFile(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');
    const factory = extractLazyPanelFactory(source, 'tech-hubs');

    assert.match(
      factory,
      /hydrateTechHubPanelFromClusters\(p,\s*this\.ctx\.latestClusters,\s*\{\s*allowEmpty:\s*this\.ctx\.clustersSettled,?\s*\}\)/,
      'TechHubsPanel factory must backfill retained clusters, gated on clustersSettled',
    );
    assert.doesNotMatch(
      factory,
      /allowEmpty:\s*(?:true|false|this\.ctx\.initialLoadComplete)\b/,
      'allowEmpty must not be hardcoded or keyed on initialLoadComplete, which is true before clustering starts',
    );
    assert.doesNotMatch(
      factory,
      /\.catch\(\(\)\s*=>\s*\{\s*\/\*[^}]*\*\/\s*\}\)/,
      'a failed tech-activity chunk load must be logged, not silently swallowed',
    );
    assert.match(factory, /console\.error\(/, 'tech-hubs hydration failure must reach the console');
  });

  it('sets clustersSettled only after a clustering pass resolves', async () => {
    const source = await readFile(new URL('../src/app/data-loader.ts', import.meta.url), 'utf8');

    assert.match(
      source,
      /this\.ctx\.latestClusters = mlWorker\.isAvailable\n\s*\? await clusterNewsHybrid\(this\.ctx\.allNews\)\n\s*: await analysisWorker\.clusterNews\(this\.ctx\.allNews\);\n(?:\s*\/\/[^\n]*\n)*\s*this\.ctx\.clustersSettled = true;/,
      'clustersSettled must be set immediately after the clustering assignment, never before it',
    );
    assert.doesNotMatch(
      source,
      /this\.ctx\.clustersSettled = true;[\s\S]{0,200}?this\.ctx\.latestClusters = mlWorker\.isAvailable/,
      'clustersSettled must not be set ahead of the clustering pass it describes',
    );
  });
});
