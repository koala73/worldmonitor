import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function readRepo(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function parseThreatLevels(source) {
  const match = source.match(/export const THREAT_LEVEL = \{([\s\S]*?)\};/);
  assert.ok(match, 'THREAT_LEVEL export not found');
  return new Map([...match[1].matchAll(/(\w+):\s*(\d+)/g)].map(([, level, weight]) => [level, Number(weight)]));
}

function parseChokepoints(source) {
  return [...source.matchAll(/\{\s*id:\s*'([^']+)'.*?name:\s*'([^']+)'.*?threatLevel:\s*'([^']+)'/gs)]
    .map(([, id, name, threatLevel]) => ({ id, name, threatLevel }));
}

function parseLiveFlowMappings(source) {
  return [...source.matchAll(/\{\s*canonicalId:\s*'([^']+)'.*?baselineId:\s*'([^']+)'/gs)]
    .map(([, canonicalId, baselineId]) => ({ canonicalId, baselineId }));
}

function parseMethodologyLiveFlowMappings(source) {
  const tableHeader = '| Canonical id | Public name | EIA baseline id | Baseline flow (mb/d) |';
  const tableStart = source.indexOf(tableHeader);
  assert.notEqual(tableStart, -1, 'methodology live-flow table not found');
  const tableEnd = source.indexOf('\n\nThe other six', tableStart);
  assert.notEqual(tableEnd, -1, 'methodology live-flow table end not found');
  const table = source.slice(tableStart, tableEnd);
  return [...table.matchAll(/^\| `([^`]+)` \| [^|]+ \| `([^`]+)` \| [0-9.]+ \|$/gm)]
    .map(([, canonicalId, baselineId]) => ({ canonicalId, baselineId }));
}

function parseSeededReporters(source) {
  const match = source.match(/SEEDED_REPORTERS\s*=\s*\[([^\]]+)\]/);
  assert.ok(match, 'SEEDED_REPORTERS declaration not found');
  return [...match[1].matchAll(/'([A-Z]{2})'/g)].map(([, iso2]) => iso2);
}

function containsSeededReporters(text, seededReporters) {
  const normalized = text
    .replace(/`/g, '')
    .replace(/, and /g, ', ')
    .replace(/\s+/g, ' ');
  return normalized.includes(seededReporters.join(', '));
}

function extractBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `${label} start not found`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `${label} end not found`);
  return source.slice(start, end);
}

function extractProtoMessage(source, messageName) {
  return extractBetween(source, `message ${messageName} {`, '\n}', `${messageName} proto message`);
}

function extractYamlSchema(source, schemaName) {
  const startNeedle = `        ${schemaName}:\n`;
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `${schemaName} schema not found`);
  const afterStart = start + startNeedle.length;
  const nextSchema = source.slice(afterStart).match(/\n        [A-Za-z0-9_]+:\n/);
  const end = nextSchema ? afterStart + nextSchema.index : source.length;
  return source.slice(start, end);
}

function warRiskEnumForThreat(threatLevel) {
  if (threatLevel === 'war_zone') return 'WAR_RISK_TIER_WAR_ZONE';
  return `WAR_RISK_TIER_${threatLevel.toUpperCase()}`;
}

describe('chokepoint methodology docs match scoring code', () => {
  const scoring = readRepo('server/worldmonitor/supply-chain/v1/_scoring.mjs');
  const statusHandler = readRepo('server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts');
  const flowSeeder = readRepo('scripts/seed-chokepoint-flows.mjs');
  const methodology = readRepo('docs/methodology/chokepoints.mdx');
  const supplyChainProto = readRepo('proto/worldmonitor/supply_chain/v1/supply_chain_data.proto');
  const exposureProto = readRepo('proto/worldmonitor/supply_chain/v1/get_country_chokepoint_index.proto');
  const supplyChainOpenApi = readRepo('docs/api/SupplyChainService.openapi.yaml');
  const bundledOpenApi = readRepo('docs/api/worldmonitor.openapi.yaml');

  it('publishes the exact threat weights and per-chokepoint assignments', () => {
    const weights = parseThreatLevels(scoring);
    const chokepoints = parseChokepoints(statusHandler);

    assert.equal(chokepoints.length, 13, 'status handler should keep 13 monitored chokepoints');
    assert.match(methodology, /13 monitored waterways/);

    for (const { id, name, threatLevel } of chokepoints) {
      const weight = weights.get(threatLevel);
      assert.equal(typeof weight, 'number', `missing weight for ${threatLevel}`);
      const warRiskEnum = warRiskEnumForThreat(threatLevel);
      const expectedRow = `| \`${id}\` | ${name} | \`${threatLevel}\` | ${weight} | \`${warRiskEnum}\` |`;
      assert.ok(methodology.includes(expectedRow), `methodology is missing assignment row: ${expectedRow}`);
    }

    for (const [level, weight] of weights) {
      assert.match(methodology, new RegExp(`\\| \`${level}\` \\| ${weight} \\|`));
    }
  });

  it('distinguishes the seven live-flow rows from the 13 monitored waterways', () => {
    const liveFlowMappings = parseLiveFlowMappings(flowSeeder);
    const methodologyMappings = parseMethodologyLiveFlowMappings(methodology);
    const methodologyBaselineByCanonicalId = new Map(methodologyMappings.map(({ canonicalId, baselineId }) => [canonicalId, baselineId]));

    assert.equal(liveFlowMappings.length, 7, 'flow seeder should keep the seven-item live-flow subset');
    assert.equal(methodologyMappings.length, liveFlowMappings.length, 'methodology should document one row per live-flow mapping');
    assert.match(methodology, /Only \*\*seven\*\* of those 13/);

    for (const { canonicalId, baselineId } of liveFlowMappings) {
      assert.equal(
        methodologyBaselineByCanonicalId.get(canonicalId),
        baselineId,
        `methodology is missing live-flow mapping ${canonicalId} -> ${baselineId}`,
      );
    }
  });

  it('documents live-flow and transit-anomaly eligibility gates', () => {
    assert.match(flowSeeder, /history\.length\s*<\s*40/, 'flow seeder should keep the 40-day total-history gate');
    assert.match(flowSeeder, /prev90\.length\s*<\s*20/, 'flow seeder should keep the 20-baseline-day gate');
    assert.match(flowSeeder, /baseline90d\s*<\s*\(useDwt\s*\?\s*1\s*:\s*0\.5\)/, 'flow seeder should keep thin-baseline floors');
    assert.match(scoring, /history\.length\s*<\s*37/, 'traffic anomaly should keep the 37-day history gate');
    assert.match(scoring, /baselineAvg7\s*<\s*14/, 'traffic anomaly should keep the 14-transit floor');

    for (const expected of [
      /at least 40 total days/i,
      /20 prior-window baseline days/i,
      /1 DWT-day/i,
      /0\.5 tanker-count/i,
      /at least 37 days/i,
      /at least 14 transits/i,
    ]) {
      assert.match(methodology, expected);
    }
  });

  it('documents current flow, status, and exposure formulas on user-facing and contract surfaces', () => {
    for (const [label, text] of [
      ['methodology', methodology],
      ['supply-chain proto', supplyChainProto],
      ['SupplyChainService OpenAPI', supplyChainOpenApi],
      ['bundled OpenAPI', bundledOpenApi],
    ]) {
      assert.match(text, /7-day/i, `${label} must mention the 7-day current flow window`);
      assert.match(text, /90 days/i, `${label} must mention the up-to-90-day baseline window`);
      assert.match(text, /0\.0-1\.5|0, 1\.5|150%/, `${label} must mention the flow-ratio clamp`);
      assert.match(text, /green.*yellow.*red|green.*<20.*yellow.*20-49.*red.*>=50/s, `${label} must document green/yellow/red status`);
    }

    for (const [label, text] of [
      ['supply-chain proto', supplyChainProto],
      ['SupplyChainService OpenAPI', supplyChainOpenApi],
      ['bundled OpenAPI', bundledOpenApi],
    ]) {
      assert.match(text, /portwatch-dwt/i, `${label} must describe FlowEstimate.source values`);
      assert.match(text, /portwatch-counts/i, `${label} must describe FlowEstimate.source values`);
      assert.match(text, /RED.*ORANGE|ORANGE.*RED/s, `${label} must describe hazard alert levels`);
      assert.match(text, /nearest active GDACS hazard/i, `${label} must describe hazard alert name semantics`);
    }

    for (const [label, text] of [
      ['methodology', methodology],
      ['exposure proto', exposureProto],
      ['SupplyChainService OpenAPI', supplyChainOpenApi],
      ['bundled OpenAPI', bundledOpenApi],
    ]) {
      assert.match(text, /routeCoverage.*exporter(?:Share|\.share).*productWeight|routeCoverage \* exporter(?:Share|\.share) \* productWeight/s, `${label} must document the exposure formula`);
      assert.match(text, /top1 \* 0\.5 \+ top2 \* 0\.3 \+ top3 \* 0\.2/, `${label} must document the vulnerability formula`);
    }
  });

  it('documents flow-estimate source and hazard fields on contract surfaces', () => {
    for (const [label, text] of [
      ['supply-chain proto', supplyChainProto],
      ['SupplyChainService OpenAPI', supplyChainOpenApi],
      ['bundled OpenAPI', bundledOpenApi],
    ]) {
      const flowEstimateContract = label === 'supply-chain proto'
        ? extractProtoMessage(text, 'FlowEstimate')
        : extractYamlSchema(text, label === 'bundled OpenAPI' ? 'worldmonitor_supply_chain_v1_FlowEstimate' : 'FlowEstimate');
      assert.match(flowEstimateContract, /portwatch-dwt/i, `${label} must document the DWT-backed flow source`);
      assert.match(flowEstimateContract, /portwatch-counts/i, `${label} must document the count-backed flow source`);
      assert.match(flowEstimateContract, /GDACS/i, `${label} must document GDACS hazard enrichment`);
      assert.match(flowEstimateContract, /configured radius/i, `${label} must document the hazard matching radius`);
      assert.match(flowEstimateContract, /"RED"/, `${label} must document RED hazard alerts`);
      assert.match(flowEstimateContract, /"ORANGE"/, `${label} must document ORANGE hazard alerts`);
      assert.match(flowEstimateContract, /empty string/i, `${label} must document the absent-hazard wire value`);
    }
  });
});

describe('scenario docs match worker scope and impact math', () => {
  const worker = readRepo('scripts/scenario-worker.mjs');
  const scenarioDoc = readRepo('docs/scenario-engine.mdx');
  const apiDoc = readRepo('docs/api-scenarios.mdx');
  const panelDoc = readRepo('docs/panels/supply-chain.mdx');
  const runProto = readRepo('proto/worldmonitor/scenario/v1/run_scenario.proto');
  const statusProto = readRepo('proto/worldmonitor/scenario/v1/get_scenario_status.proto');
  const scenarioOpenApi = readRepo('docs/api/ScenarioService.openapi.yaml');
  const bundledOpenApi = readRepo('docs/api/worldmonitor.openapi.yaml');

  it('discloses the seeded reporter scope wherever scope-all is documented', () => {
    const seededReporters = parseSeededReporters(worker);
    assert.deepEqual(seededReporters, ['US', 'CN', 'RU', 'IR', 'IN', 'TW']);

    for (const [label, text] of [
      ['scenario engine doc', scenarioDoc],
      ['API scenario doc', apiDoc],
      ['supply-chain panel doc', panelDoc],
      ['RunScenario proto', runProto],
      ['ScenarioService OpenAPI', scenarioOpenApi],
      ['bundled OpenAPI', bundledOpenApi],
    ]) {
      assert.ok(text.includes(seededReporters.join(', ')) || containsSeededReporters(text, seededReporters), `${label} must list seeded reporters: ${seededReporters.join(', ')}`);
      assert.doesNotMatch(text, /all countries with seeded exposure/i, `${label} still has stale scope-all wording`);
    }
  });

  it('documents relative impact math and queue backpressure precisely', () => {
    for (const [label, text] of [
      ['scenario engine doc', scenarioDoc],
      ['API scenario doc', apiDoc],
      ['GetScenarioStatus proto', statusProto],
      ['ScenarioService OpenAPI', scenarioOpenApi],
      ['bundled OpenAPI', bundledOpenApi],
    ]) {
      assert.match(text, /exposureScore \* \(disruptionPct \/ 100\) \* costShockMultiplier|exposureScore \* \(disruption_pct \/ 100\).*cost_shock_multiplier/s, `${label} must document physical impact formula`);
      assert.match(text, /vulnerabilityIndex \* costShockMultiplier|vulnerabilityIndex.*cost_shock_multiplier/s, `${label} must document tariff impact formula`);
      assert.match(text, /not a currency amount|Relative-only - not a currency amount/i, `${label} must call totalImpact relative`);
      assert.match(text, /max\(maxReturnedTotalImpact, 1\)|maxReturnedTotalImpact, 1|denominator floor/i, `${label} must define impactPct denominator floor`);
    }

    assert.match(apiDoc, /depth `> 100` is rejected/);
    assert.match(scenarioDoc, /already above 100/);
  });

  it('documents scenario result template name as a derived key, not a display name', () => {
    assert.match(
      worker,
      /name:\s*template\.affectedChokepointIds\.join\('\+'\)\s*\|\|\s*'tariff_shock'/,
      'scenario worker must keep deriving result.template.name from affected chokepoint ids',
    );

    for (const [label, section] of [
      ['scenario engine doc Template echo section', extractBetween(scenarioDoc, '- **Template echo**', '- **A summary card**', 'scenario engine template echo section')],
      ['API scenario doc template.name note', extractBetween(apiDoc, 'In the status payload, `template.name` is the worker-derived key', '`totalImpact` is a relative', 'API scenario template.name note')],
      ['GetScenarioStatus proto ScenarioResultTemplate message', extractProtoMessage(statusProto, 'ScenarioResultTemplate')],
      ['ScenarioService OpenAPI ScenarioResultTemplate schema', extractYamlSchema(scenarioOpenApi, 'ScenarioResultTemplate')],
      ['bundled OpenAPI ScenarioResultTemplate schema', extractYamlSchema(bundledOpenApi, 'worldmonitor_scenario_v1_ScenarioResultTemplate')],
    ]) {
      assert.match(section, /worker-derived template key|worker-derived key/i, `${label} must call template.name worker-derived`);
      assert.match(section, /affectedChokepointIds|affected_chokepoint_ids|affected chokepoint ids/i, `${label} must tie template.name to affected chokepoint ids`);
      assert.match(section, /\+/, `${label} must document plus-joining for physical scenarios`);
      assert.match(section, /tariff_shock/, `${label} must document the non-physical tariff fallback`);
      assert.doesNotMatch(section, /selected template'?s display name|Display name \(worker derives this from affected_chokepoint_ids/i, `${label} must not describe result.template.name as a display name`);
    }
  });
});
