import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDependencyGraph,
  calculateCascade,
  getGraphStats,
  getPipelineById,
  getPortById,
} from '../shared/analysis-infrastructure-cascade.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Two Atlantic cables sharing GB so the redundancy finder has an alternative.
const CABLES = [
  {
    id: 'atlantic-1',
    name: 'Atlantic Express',
    points: [
      [-10, 50],
      [-70, 40],
    ],
    capacityTbps: 100,
    countriesServed: [
      { country: 'GB', capacityShare: 0.6, isRedundant: false },
      { country: 'US', capacityShare: 0.3, isRedundant: true },
    ],
    landingPoints: [{ country: 'GB', countryName: 'United Kingdom', lat: 50, lon: -10 }],
  },
  {
    id: 'atlantic-2',
    name: 'Atlantic Backup',
    points: [[-9, 51]],
    countriesServed: [{ country: 'GB', capacityShare: 0.2, isRedundant: true }],
  },
];

const PIPELINES = [
  {
    id: 'transnorth',
    name: 'TransNorth',
    type: 'gas',
    status: 'operating',
    points: [
      [5, 55],
      [8, 52],
    ],
    capacity: '40 bcm/year',
    operator: 'Test Operator',
    countries: ['NO', 'DE'],
  },
];

// singapore sits ~295km from the malacca_strait fixture (inside the 500km radius);
// rotterdam is far outside it.
const PORTS = [
  { id: 'singapore', name: 'Port of Singapore', lat: 1.26, lon: 103.84, country: 'Singapore', type: 'mixed', rank: 2, note: '' },
  { id: 'rotterdam', name: 'Port of Rotterdam', lat: 51.9, lon: 4.5, country: 'Netherlands', type: 'container', rank: 10, note: '' },
];

const WATERWAYS = [
  { id: 'malacca_strait', chokepointId: 'malacca_strait', name: 'MALACCA STRAIT', lat: 2.5, lon: 101.5, description: 'Major oil shipping route' },
];

function buildFixtureGraph() {
  return buildDependencyGraph({
    cables: CABLES,
    pipelines: PIPELINES,
    ports: PORTS,
    waterways: WATERWAYS,
  });
}

function closeTo(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ~${expected}, got ${actual}`,
  );
}

describe('infrastructure cascade core — graph build', () => {
  it('creates one node per asset plus every country reachable from the datasets', () => {
    const stats = getGraphStats(buildFixtureGraph());

    assert.equal(stats.cables, 2);
    assert.equal(stats.pipelines, 1);
    assert.equal(stats.ports, 2);
    assert.equal(stats.chokepoints, 1);
    // GB/US from cables, NO/DE from the pipeline, SG/NL from port locations,
    // CN/JP/KR pulled in by the Singapore trade-route + Malacca dependencies.
    assert.equal(stats.countries, 9);
    assert.equal(stats.nodes, 15);
    // 4 cable→country, 2 pipeline→country, 5 port→country, 4 chokepoint edges.
    assert.equal(stats.edges, 15);
  });

  it('weights port→country edges by port type and rank, and indexes edges both ways', () => {
    const graph = buildFixtureGraph();

    const sgEdge = graph.outgoing.get('port:singapore')?.find(e => e.to === 'country:SG');
    assert.ok(sgEdge, 'singapore should serve country:SG');
    assert.equal(sgEdge.type, 'serves');
    // mixed (0.6) + rank-2 boost ((20-2)/20 * 0.3 = 0.27)
    closeTo(sgEdge.strength, 0.87, 'singapore importance');
    closeTo(sgEdge.redundancy, 0.2, 'top-5 ports are harder to replace');

    assert.ok(
      graph.incoming.get('country:SG')?.some(e => e.from === 'port:singapore'),
      'incoming index must mirror the outgoing edge',
    );
  });

  it('links chokepoints only to ports inside the 500km radius', () => {
    const graph = buildFixtureGraph();
    const access = (graph.outgoing.get('chokepoint:malacca_strait') ?? []).filter(
      e => e.type === 'controls_access',
    );

    assert.deepEqual(access.map(e => e.to), ['port:singapore']);
  });

  it('falls back to the bundled pipeline and port datasets when none are supplied', () => {
    const stats = getGraphStats(buildDependencyGraph({ cables: [], waterways: [] }));

    assert.ok(stats.pipelines >= 20, `expected the bundled PIPELINES, got ${stats.pipelines}`);
    assert.ok(stats.ports >= 20, `expected the bundled PORTS, got ${stats.ports}`);
    assert.equal(stats.cables, 0);
  });
});

describe('infrastructure cascade core — cascade simulation', () => {
  it('propagates a cable failure to the countries it serves', () => {
    const result = calculateCascade(buildFixtureGraph(), 'cable:atlantic-1', 1.0);

    assert.ok(result);
    assert.equal(result.source.name, 'Atlantic Express');

    const byCountry = new Map(result.countriesAffected.map(c => [c.country, c]));
    assert.deepEqual(result.countriesAffected.map(c => c.country), ['GB', 'US']);

    // 0.6 strength, no redundancy → high
    assert.equal(byCountry.get('GB').impactLevel, 'high');
    closeTo(byCountry.get('GB').affectedCapacity, 0.6, 'GB capacity share');

    // 0.3 strength halved by 0.5 redundancy → 0.15 → low
    assert.equal(byCountry.get('US').impactLevel, 'low');
    closeTo(byCountry.get('US').affectedCapacity, 0.3, 'US capacity share');

    const gb = result.affectedNodes.find(n => n.node.id === 'country:GB');
    assert.equal(gb.pathLength, 1);
    assert.deepEqual(gb.dependencyChain, ['cable:atlantic-1', 'country:GB']);
    assert.equal(gb.redundancyAvailable, false);
    assert.equal(gb.estimatedRecovery, 'High - limited redundancy');

    const us = result.affectedNodes.find(n => n.node.id === 'country:US');
    assert.equal(us.redundancyAvailable, true);
  });

  it('scales impact with disruptionLevel and drops sub-threshold effects', () => {
    const graph = buildFixtureGraph();

    const half = calculateCascade(graph, 'cable:atlantic-1', 0.5);
    const halfGb = half.countriesAffected.find(c => c.country === 'GB');
    assert.equal(halfGb.impactLevel, 'medium', '0.6 * 0.5 = 0.30 → medium');

    const faint = calculateCascade(graph, 'cable:atlantic-1', 0.1);
    assert.deepEqual(
      faint.countriesAffected.map(c => c.country),
      ['GB'],
      'US falls under the 0.05 impact floor at disruptionLevel 0.1',
    );
    assert.equal(faint.countriesAffected[0].impactLevel, 'low');
  });

  it('walks multi-hop chokepoint → port → country chains and multiplies path capacity', () => {
    const result = calculateCascade(buildFixtureGraph(), 'chokepoint:malacca_strait', 1.0);

    assert.deepEqual(
      result.countriesAffected.map(c => c.country),
      ['SG', 'CN', 'JP', 'KR'],
      'sorted by impact level, then by affected capacity',
    );

    const sg = result.affectedNodes.find(n => n.node.id === 'country:SG');
    assert.equal(sg.pathLength, 2);
    assert.deepEqual(sg.dependencyChain, [
      'chokepoint:malacca_strait',
      'port:singapore',
      'country:SG',
    ]);

    // (0.7 * 0.8) * (0.87 * 0.8)
    const sgImpact = result.countriesAffected.find(c => c.country === 'SG');
    closeTo(sgImpact.affectedCapacity, 0.56 * 0.696, 'chained path capacity');

    // Direct chokepoint → country edge: 0.7 * (1 - 0.3)
    const cn = result.countriesAffected.find(c => c.country === 'CN');
    closeTo(cn.affectedCapacity, 0.49, 'direct trade-dependency capacity');
    assert.equal(cn.impactLevel, 'medium');
  });

  it('offers alternative cables that serve the same countries', () => {
    const result = calculateCascade(buildFixtureGraph(), 'cable:atlantic-1', 1.0);

    assert.deepEqual(result.redundancies, [
      { id: 'atlantic-2', name: 'Atlantic Backup', capacityShare: 0.2 },
    ]);
  });

  it('reports no redundancies for non-cable sources', () => {
    const result = calculateCascade(buildFixtureGraph(), 'chokepoint:malacca_strait', 1.0);
    assert.deepEqual(result.redundancies, []);
  });

  it('returns null for an unknown source id', () => {
    const graph = buildFixtureGraph();
    assert.equal(calculateCascade(graph, 'cable:does-not-exist', 1.0), null);
    assert.equal(calculateCascade(graph, 'country:GB', 1.0)?.affectedNodes.length, 0);
  });
});

describe('infrastructure cascade core — lookups', () => {
  it('finds pipelines and ports in a supplied dataset', () => {
    assert.equal(getPipelineById('transnorth', PIPELINES)?.name, 'TransNorth');
    assert.equal(getPortById('rotterdam', PORTS)?.country, 'Netherlands');
    assert.equal(getPipelineById('nope', PIPELINES), undefined);
    assert.equal(getPortById('nope', PORTS), undefined);
  });

  it('defaults to the bundled datasets', () => {
    assert.equal(getPipelineById('keystone')?.name, 'Keystone Pipeline');
    assert.equal(getPortById('shanghai')?.country, 'China');
  });
});

describe('infrastructure cascade core — server importability', () => {
  const SERVER_IMPORTABLE = [
    'shared/analysis-infrastructure-cascade.ts',
    'shared/pipelines-data.ts',
    'shared/ports-data.ts',
  ];

  for (const relPath of SERVER_IMPORTABLE) {
    it(`${relPath} has no client-only imports`, () => {
      const src = readFileSync(resolve(repoRoot, relPath), 'utf-8');
      assert.ok(
        !/from\s*['"]@\//.test(src),
        `${relPath} must not import through the @/ (src) alias — it has to bundle server-side`,
      );
      assert.ok(
        !/from\s*['"][^'"]*\/src\//.test(src),
        `${relPath} must not reach into src/`,
      );
    });
  }
});
