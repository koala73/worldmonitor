import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function readRepo(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function countSignalTableRows(doc: string): number {
  const section = doc.match(/### Signal Types([\s\S]*?)### How It Works/);
  assert.ok(section, 'signal docs must include a Signal Types section before How It Works');
  return (section[1].match(/^\| \*\*/gm) || []).length;
}

test('public signal docs keep their listed signal count in sync with the tables', () => {
  for (const path of ['docs/signal-intelligence.mdx', 'docs/Docs_To_Review/DOCUMENTATION.md'] as const) {
    const doc = readRepo(path);
    const countMatch = doc.match(/lists (\d+) distinct signal types/);
    assert.ok(countMatch, `${path} must publish the listed signal type count`);
    assert.equal(Number(countMatch[1]), countSignalTableRows(doc), `${path} signal count must match listed rows`);
  }
});

test('public signal docs stay aligned with hotspot escalation math', () => {
  const hotspotCode = readRepo('src/services/hotspot-escalation.ts');
  const hotspotsDoc = readRepo('docs/hotspots.mdx');
  const algorithmsDoc = readRepo('docs/algorithms.mdx');

  assert.match(hotspotCode, /return hotspot\.escalationScore \?\? 3;/);
  assert.match(hotspotCode, /return 1 \+ \(raw \/ 100\) \* 4;/);
  assert.match(hotspotCode, /return staticBaseline \* 0\.3 \+ dynamicScore \* 0\.7;/);

  for (const [label, doc] of [
    ['docs/hotspots.mdx', hotspotsDoc],
    ['docs/algorithms.mdx', algorithmsDoc],
  ] as const) {
    assert.match(
      doc,
      /static_?baseline[\s\S]{0,120}escalationScore|escalationScore[\s\S]{0,120}staticBaseline/i,
      `${label} must publish hotspot static baseline source`,
    );
    assert.match(doc, /0\.30[\s\S]{0,120}0\.70/, `${label} must publish hotspot 30\/70 blend`);
    assert.match(doc, /1-5/, `${label} must state hotspot scores are on a 1-5 scale`);
    assert.doesNotMatch(doc, /proximity_boost/, `${label} must not document a nonexistent hotspot proximity boost`);
  }
});

test('public convergence and alert docs stay aligned with current priority and queue caps', () => {
  const geoCode = readRepo('src/services/geo-convergence.ts');
  const crossModuleCode = readRepo('src/services/cross-module-integration.ts');
  const geoDoc = readRepo('docs/geographic-convergence.mdx');
  const strategicRiskDoc = readRepo('docs/strategic-risk.mdx');
  const algorithmsDoc = readRepo('docs/algorithms.mdx');

  assert.match(geoCode, /const CONVERGENCE_THRESHOLD = 3;/);
  assert.match(crossModuleCode, /if \(typeCount >= 4 \|\| score >= 90\) return 'critical';/);
  assert.match(crossModuleCode, /if \(typeCount >= 3 \|\| score >= 70\) return 'high';/);
  assert.match(crossModuleCode, /if \(alerts\.length > 50\) alerts\.pop\(\);/);
  assert.match(crossModuleCode, /if \(alerts\.length > 100\) \{[\s\S]*alerts\.length = 100;/);

  assert.match(geoDoc, /3\+ distinct event types/);
  assert.match(geoDoc, /4 types[\s\S]*100[\s\S]*Critical/);
  assert.match(geoDoc, /3 types[\s\S]*81-89[\s\S]*High/);
  assert.doesNotMatch(geoDoc, /3 types\*\* \(low count\)[\s\S]*Medium/);

  assert.match(strategicRiskDoc, /convergence has 4\+ types or score [^\s]+90/);
  assert.match(strategicRiskDoc, /convergence has 3\+ types or score [^\s]+70/);
  assert.match(algorithmsDoc, /Direct inserts pop the oldest alert after 50 entries[\s\S]*trims the recomputed queue to 100 entries/);
});

test('public Escalation Monitor docs publish the current adapter weights and gates', () => {
  const adapterCode = readRepo('src/services/correlation-engine/adapters/escalation.ts');
  const indicatorsDoc = readRepo('docs/panels/indicators-and-signals.mdx');
  const algorithmsDoc = readRepo('docs/algorithms.mdx');

  assert.match(adapterCode, /conflict_event: 0\.45/);
  assert.match(adapterCode, /escalation_outage: 0\.25/);
  assert.match(adapterCode, /news_severity: 0\.30/);
  assert.match(adapterCode, /timeWindow: 48/);
  assert.match(adapterCode, /threshold: 20/);
  assert.match(
    adapterCode,
    /signals\.filter\(s => s\.type !== 'escalation_outage' \|\| conflictCountries\.has\(s\.country\)\)/,
  );

  for (const [label, doc] of [
    ['docs/panels/indicators-and-signals.mdx', indicatorsDoc],
    ['docs/algorithms.mdx', algorithmsDoc],
  ] as const) {
    assert.match(doc, /45%/, `${label} must publish conflict_event weight`);
    assert.match(doc, /25%/, `${label} must publish escalation_outage weight`);
    assert.match(doc, /30%/, `${label} must publish news_severity weight`);
    assert.match(doc, /48h|48-hour/, `${label} must publish Escalation Monitor window`);
  }
});
