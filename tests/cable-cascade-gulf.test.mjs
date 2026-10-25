import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDependencyGraph,
  calculateCascade,
  calculateChokepointCableCut,
  calculateMultiCascade,
  CABLE_ESTIMATE_NOTE,
  getCablesThroughChokepoint,
} from '../shared/analysis-infrastructure-cascade.ts';
import { MCP_CASCADE_WATERWAYS } from '../shared/analysis-mcp-adapters.ts';
import { UNDERSEA_CABLES } from '../src/config/geo-map.ts';

const graph = buildDependencyGraph({ cables: UNDERSEA_CABLES, waterways: MCP_CASCADE_WATERWAYS });
const HORMUZ = 'chokepoint:hormuz_strait';

describe('cable cascade — small serves edge no longer blocks the lands_at edge', () => {
  // Regression: the BFS marked a country visited before the 0.05 cutoff, so a
  // weak `serves` edge (share <= 0.09 x 0.5) hid the same cable's `lands_at`
  // edge and these cuts reported zero affected countries.
  const cases = [
    ['falcon', ['AE', 'BH', 'IR', 'KW', 'QA', 'SA']],
    ['seamewe_6', ['AE', 'BH', 'QA']],
    ['asia_africa_europe_1_aae_1', ['QA']],
    ['2africa', ['AE', 'BH', 'KW', 'QA', 'SA']],
  ];
  for (const [id, mustInclude] of cases) {
    it(`${id} affects its landing countries`, () => {
      const result = calculateCascade(graph, `cable:${id}`, 1);
      assert.ok(result, `${id} exists in the dataset`);
      const codes = new Set(result.countriesAffected.map(c => c.country));
      assert.ok(codes.size > 0, `${id} must affect at least one country`);
      for (const code of mustInclude) assert.ok(codes.has(code), `${id} should affect ${code}, got ${[...codes].join(',')}`);
    });
  }
});

describe('cable cascade — estimates are labelled', () => {
  it('cable results carry the estimate note', () => {
    const result = calculateCascade(graph, 'cable:falcon', 1);
    assert.deepEqual(result.dataQuality, { estimated: true, note: CABLE_ESTIMATE_NOTE });
  });

  it('non-cable results do not', () => {
    const result = calculateCascade(graph, HORMUZ, 1);
    assert.equal(result?.dataQuality, undefined);
  });
});

describe('cable cascade — chokepoint cut zone', () => {
  it('identifies the cables crossing Hormuz and excludes Gulf of Oman / intra-Gulf systems', () => {
    const ids = getCablesThroughChokepoint(graph, HORMUZ);
    for (const id of ['falcon', 'seamewe_6', 'asia_africa_europe_1_aae_1', '2africa', 'tata_tgn_gulf', 'omranepeg',
      'gulf_bridge_international_cable_systemmiddle_east_north_africa_cable_system_gbicsmena']) {
      assert.ok(ids.includes(`cable:${id}`), `${id} crosses Hormuz`);
    }
    // Land at Fujairah / Kalba / Oman, or stay entirely inside the Gulf.
    for (const id of ['seamewe_4', 'seamewe_5', 'imewe', 'europe_india_gateway_eig', 'peace_cable', 'uae_iran', 'kuwait_iran']) {
      assert.ok(!ids.includes(`cable:${id}`), `${id} does not cross Hormuz`);
    }
  });

  it('a Hormuz cable cut adds up per-country impacts across the cut set', () => {
    const result = calculateChokepointCableCut(graph, HORMUZ, 1);
    assert.ok(result);
    assert.equal(result.source.type, 'route');
    assert.equal(result.sources?.length, getCablesThroughChokepoint(graph, HORMUZ).length);
    const qa = result.countriesAffected.find(c => c.country === 'QA');
    const singleQa = calculateCascade(graph, 'cable:falcon', 1).countriesAffected.find(c => c.country === 'QA');
    assert.ok(qa && singleQa && qa.affectedCapacity > singleQa.affectedCapacity);
    assert.ok(qa.affectedCapacity <= 1);
    assert.equal(result.dataQuality?.estimated, true);
  });

  it('combines small country hits before applying the impact cutoff', () => {
    const ids = ['cable:falcon', 'cable:tata_tgn_gulf'];
    for (const id of ids) {
      assert.deepEqual(calculateCascade(graph, id, 0.2).countriesAffected, []);
    }

    const result = calculateMultiCascade(graph, ids, 0.2);
    const qa = result.countriesAffected.find(c => c.country === 'QA');
    assert.ok(qa, 'two 0.03 hits must retain Qatar after their combined 0.06 clears the cutoff');
    assert.equal(qa.impactLevel, 'low');
    assert.ok(result.affectedNodes.some(hit => hit.node.id === 'country:QA'));
    assert.deepEqual(calculateMultiCascade(graph, ids, 0.1).countriesAffected, []);
    assert.deepEqual(calculateMultiCascade(graph, [ids[0], ids[0]], 0.2).countriesAffected, []);
  });

  it('rejects the whole cut when any requested node is unknown', () => {
    assert.equal(calculateMultiCascade(graph, ['cable:falcon', 'cable:nope']), null);
    assert.equal(calculateMultiCascade(graph, ['cable:nope', 'cable:falcon']), null);
  });

  it('alternatives never include a cut cable and rank zone-avoiding cables first', () => {
    const cut = getCablesThroughChokepoint(graph, HORMUZ);
    const result = calculateMultiCascade(graph, cut, 1, 'Hormuz');
    const alts = result.redundancies ?? [];
    assert.ok(alts.length > 0);
    for (const alt of alts) assert.ok(!cut.includes(`cable:${alt.id}`), `${alt.id} is in the cut set`);
    const firstCrossing = alts.findIndex(a => a.avoidsCutZone === false);
    if (firstCrossing !== -1) assert.ok(alts.slice(firstCrossing).every(a => a.avoidsCutZone === false));
  });

  it('single-cable alternatives prefer cables that avoid the same chokepoint', () => {
    const alts = calculateCascade(graph, 'cable:falcon', 1).redundancies ?? [];
    assert.ok(alts.length > 0);
    assert.equal(alts[0].avoidsCutZone, true);
  });

  it('multi-cut with unknown ids returns null and a single id behaves like calculateCascade', () => {
    assert.equal(calculateMultiCascade(graph, ['cable:nope'], 1), null);
    assert.deepEqual(
      calculateMultiCascade(graph, ['cable:falcon'], 1)?.countriesAffected,
      calculateCascade(graph, 'cable:falcon', 1)?.countriesAffected,
    );
    assert.equal(calculateChokepointCableCut(graph, 'chokepoint:nope', 1), null);
  });
});
