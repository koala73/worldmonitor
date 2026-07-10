import assert from 'node:assert/strict';
import { readFileSync as originalReadFileSync } from 'node:fs';
function readFileSync(path: any, options?: any): any {
  const content = originalReadFileSync(path, options);
  if (typeof content === 'string') {
    return content.replace(/\r\n/g, '\n');
  }
  return content;
}
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CII_FORMULA_VERSION,
  STRATEGIC_RISK_POSITIONAL_DECAY,
  STRATEGIC_RISK_TOP_N,
} from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { CII_COUNTRY_WEIGHTS } from '../shared/cii-weights.ts';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function findNextMarkdownHeadingOffset(text: string, start: number): number {
  const remainder = text.slice(start);
  const lines = remainder.split('\n');
  let offset = 0;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
    } else if (!inFence && /^#{1,3} /.test(line)) {
      return offset;
    }
    offset += line.length + (i < lines.length - 1 ? 1 : 0);
  }

  return -1;
}

function markdownSection(text: string, heading: string): string {
  const marker = `${heading}\n`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `Expected markdown section heading "${heading}"`);
  const sectionStart = start + marker.length;
  const nextHeading = findNextMarkdownHeadingOffset(text, sectionStart);
  return nextHeading === -1
    ? text.slice(sectionStart)
    : text.slice(sectionStart, sectionStart + nextHeading);
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function parseStrategicRiskDisplayBands(source: string): Array<{ min: number; label: string }> {
  const match = source.match(/const STRATEGIC_RISK_BANDS:[\s\S]*?=\s*\[([\s\S]*?)\]\s*as const;/);
  assert.ok(match, 'StrategicRiskPanel STRATEGIC_RISK_BANDS declaration not found');
  return [...match[1]!.matchAll(/\{\s*min:\s*(\d+),\s*levelKey:\s*'([^']+)'/g)]
    .map(([, min, label]) => ({ min: Number(min), label: titleCase(label!) }));
}

function displayBandRows(bands: Array<{ min: number; label: string }>): Array<{ range: string; label: string }> {
  return bands.map((band, index) => {
    const upper = index === 0 ? 100 : bands[index - 1]!.min - 1;
    if (index === 0) return { range: `>=${band.min}`, label: band.label };
    if (band.min === 0) return { range: `&lt;${upper + 1}`, label: band.label };
    return { range: `${band.min}-${upper}`, label: band.label };
  });
}

function parseStrategicRiskServerBands(source: string): Array<{ range: string; enumValue: string }> {
  const high = source.match(/overallScore\s*>=\s*(\d+)\s*\n\s*\?\s*'SEVERITY_LEVEL_HIGH'/);
  const medium = source.match(/overallScore\s*>=\s*(\d+)\s*\n\s*\?\s*'SEVERITY_LEVEL_MEDIUM'/);
  assert.ok(high, 'server StrategicRisk HIGH threshold not found');
  assert.ok(medium, 'server StrategicRisk MEDIUM threshold not found');
  const highMin = Number(high[1]);
  const mediumMin = Number(medium[1]);
  return [
    { range: `${highMin}-100`, enumValue: 'SEVERITY_LEVEL_HIGH' },
    { range: `${mediumMin}-${highMin - 1}`, enumValue: 'SEVERITY_LEVEL_MEDIUM' },
    { range: `0-${mediumMin - 1}`, enumValue: 'SEVERITY_LEVEL_LOW' },
  ];
}

describe('CII docs drift guards', () => {
  it('internal review docs do not retain stale CII country-count or source-of-truth claims', () => {
    const internalDocPaths = [
      'docs/Docs_To_Review/todo_docs.md',
      'docs/Docs_To_Review/todo.md',
      'docs/Docs_To_Review/TODO_Performance.md',
      'docs/Docs_To_Review/COMPONENTS.md',
    ];
    const escapedFormulaVersion = CII_FORMULA_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const staleCiiFormulaVersionClaim = new RegExp(
      String.raw`\bCII\s+(?!${escapedFormulaVersion}\b)v\d+\s+(?:stability|stress|instability|scores?|scoring|formula)\b`,
      'i',
    );
    const stalePublishedCiiVersionClaim = new RegExp(
      String.raw`\b(?:server-authoritative|published)\s+CII\s+(?:is\s+)?(?:server-authoritative\s+)?(?!${escapedFormulaVersion}\b)v\d+\b`,
      'i',
    );
    const staleCurrentCiiPublishedVersionClaim = new RegExp(
      String.raw`\bCII\b[^\n.]{0,80}\bserver-authoritative\s+(?!${escapedFormulaVersion}\b)v\d+\s+scores?\b`,
      'i',
    );
    assert.match(
      'CII currently publishes server-authoritative v6 scores for 31 Tier-1 countries',
      staleCurrentCiiPublishedVersionClaim,
      'internal docs guard must catch todo.md-style stale formula-version wording',
    );
    assert.doesNotMatch(
      `CII currently publishes server-authoritative ${CII_FORMULA_VERSION} scores for 31 Tier-1 countries`,
      staleCurrentCiiPublishedVersionClaim,
      'internal docs guard must allow the current formula version in todo.md-style wording',
    );
    const stalePatterns = [
      /22-country CII computation/i,
      /20 hardcoded Tier 1 countries/i,
      /\bCII\s+v5\s+(?:stability|stress|instability|scores?|scoring)\b/i,
      /\breal-time\s+CII\s+v5\s+instability\s+score\b/i,
      /\bComputes\s+CII\s+v5\s+scores\b/i,
      /\bserver-authoritative\s+CII\s+v5\s+scoring\b/i,
      staleCiiFormulaVersionClaim,
      stalePublishedCiiVersionClaim,
      staleCurrentCiiPublishedVersionClaim,
      /src\/workers\/cii\.worker\.ts/i,
      /src\/components\/CIIPanel\.ts` \(150 lines\)/i,
      /\*\*Country Instability Index\*\* \(`country-instability\.ts`\)/i,
    ];

    const violations: string[] = [];
    for (const relPath of internalDocPaths) {
      const text = readFileSync(resolve(root, relPath), 'utf8');
      for (const pattern of stalePatterns) {
        if (pattern.test(text)) violations.push(`${relPath}: ${pattern}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `internal CII review docs contain stale claims:\n  ${violations.join('\n  ')}`,
    );
  });

  it('strategic risk doc publishes current panel display bands, server severity bands, and roll-up', () => {
    const doc = readFileSync(resolve(root, 'docs', 'strategic-risk.mdx'), 'utf8');
    const panelSource = readFileSync(resolve(root, 'src', 'components', 'StrategicRiskPanel.ts'), 'utf8');
    const serverSource = readFileSync(
      resolve(root, 'server', 'worldmonitor', 'intelligence', 'v1', 'get-risk-scores.ts'),
      'utf8',
    );
    const scoreSection = markdownSection(doc, '### Server Score and Browser Fallback (0-100)');
    const riskLevels = markdownSection(doc, '### Risk Levels');
    const trendSection = markdownSection(doc, '### Trend Detection');
    const pizzintSection = markdownSection(doc, '### DEFCON-Style Alerting');
    const gdeltSection = markdownSection(doc, '### GDELT Tension Pairs');
    const multipliersSection = markdownSection(doc, '### Event Significance Multipliers');

    assert.match(
      scoreSection,
      /weights = \[1\.00, 0\.85, 0\.70, 0\.55, 0\.40\][\s\S]*\* 0\.70 \+ 15/,
      'strategic-risk doc must publish the server top-5 weights, scale factor, and floor',
    );
    assert.match(
      scoreSection,
      /local\s+fallback/i,
      'strategic-risk doc must label the additive overview as browser/local fallback',
    );
    assert.match(riskLevels, /Panel-visible display labels/i);
    assert.match(riskLevels, /Server\/on-wire enum labels/i);
    for (const { range, label } of displayBandRows(parseStrategicRiskDisplayBands(panelSource))) {
      assert.match(
        riskLevels,
        new RegExp(`\\|\\s*${range}\\s*\\|\\s*\\*\\*${label}\\*\\*\\s*\\|`),
        `strategic-risk doc must publish panel display band ${range} ${label}`,
      );
    }
    for (const { range, enumValue } of parseStrategicRiskServerBands(serverSource)) {
      assert.match(
        riskLevels,
        new RegExp(`\\|\\s*${range}\\s*\\|\\s*\`${enumValue}\`\\s*\\|`),
        `strategic-risk doc must publish server API band ${range} ${enumValue}`,
      );
    }
    assert.doesNotMatch(
      riskLevels,
      /Trend Icon|Escalating|De-escalating/,
      'strategic-risk risk-level table must not imply score bands determine trend labels',
    );
    assert.match(
      trendSection,
      /server-published global `StrategicRisk` headline[\s\S]{0,140}sets `trend` to stable/i,
      'strategic-risk doc must disclose the current server StrategicRisk trend contract',
    );
    assert.match(
      trendSection,
      /browser fallback computes its own[\s\S]{0,120}panel trend/i,
      'strategic-risk doc must separate browser fallback trend from the server contract',
    );
    assert.match(pizzintSection, /\|\s*\*\*DEFCON 1\*\*\s*\|\s*≥85%\s*\|\s*Maximum Activity\s*\|/);
    assert.match(pizzintSection, /\|\s*\*\*DEFCON 2\*\*\s*\|\s*70% – 84%\s*\|\s*High Activity\s*\|/);
    assert.match(pizzintSection, /\|\s*\*\*DEFCON 3\*\*\s*\|\s*50% – 69%\s*\|\s*Elevated Activity\s*\|/);
    assert.match(pizzintSection, /\|\s*\*\*DEFCON 4\*\*\s*\|\s*25% – 49%\s*\|\s*Above Normal\s*\|/);
    assert.match(pizzintSection, /\|\s*\*\*DEFCON 5\*\*\s*\|\s*&lt;25%\s*\|\s*Normal Activity\s*\|/);
    assert.doesNotMatch(
      pizzintSection,
      /≥90%|≥75%|COCKED PISTOL|FAST PACE|ROUND HOUSE|DOUBLE TAKE|FADE OUT/,
      'strategic-risk PizzINT table must not retain stale relay thresholds or labels',
    );
    assert.match(
      gdeltSection,
      /\|\s*Pair\s*\|\s*Monitored Relationship\s*\|/,
      'strategic-risk GDELT section must keep the expected pair table',
    );
    for (const pair of [
      'USA ↔ Russia',
      'Russia ↔ Ukraine',
      'USA ↔ China',
      'China ↔ Taiwan',
      'USA ↔ Iran',
      'USA ↔ Venezuela',
    ]) {
      assert.match(gdeltSection, new RegExp(`\\|\\s*${pair}\\s*\\|`));
    }
    assert.doesNotMatch(
      gdeltSection,
      /Israel ↔ Iran/,
      'strategic-risk GDELT table must match DEFAULT_GDELT_PAIRS and omit stale Israel-Iran pair',
    );
    assert.equal(CII_COUNTRY_WEIGHTS.US.eventMultiplier, 0.3);
    assert.match(
      multipliersSection,
      /\|\s*0\.3x\s*\|\s*US\s*\|/,
      'strategic-risk doc must publish the US event multiplier separately from the 0.5-0.8x bucket',
    );
    assert.doesNotMatch(
      multipliersSection,
      /\|\s*0\.5-0\.8x\s*\|[^|\n]*\bUS\b/,
      'strategic-risk doc must not list US in the 0.5-0.8x multiplier bucket',
    );
    assert.doesNotMatch(
      riskLevels,
      /70\/50\/30|50-69|30-49|\*\*Moderate\*\*/,
      'strategic-risk risk-level tables must not retain old 70/50/30 display semantics',
    );
  });

  it('CII methodology doc keeps Strategic Risk positional-decay rationale aligned with the top-N cap', () => {
    const doc = readFileSync(resolve(root, 'docs/methodology/cii-risk-scores.mdx'), 'utf8');
    const config = readFileSync(resolve(root, 'server/worldmonitor/intelligence/v1/_risk-config.ts'), 'utf8');
    const section = markdownSection(doc, '## 3. Strategic Risk roll-up');
    const nextOneBasedPosition = STRATEGIC_RISK_TOP_N + 1;
    const nextZeroBasedIndex = STRATEGIC_RISK_TOP_N;
    const nextPositionWeight = 1 - nextZeroBasedIndex * STRATEGIC_RISK_POSITIONAL_DECAY;

    assert.equal(STRATEGIC_RISK_TOP_N, 5, 'test assumes the current published top-5 roll-up window');
    assert.equal(
      Math.round(nextPositionWeight * 100) / 100,
      0.25,
      'the next 1-based position 6 / 0-based index 5 remains non-zero with decay=0.15; docs must not claim it hits zero',
    );
    for (const surface of [
      { label: 'methodology doc', text: section },
      { label: 'risk config comment', text: config },
    ]) {
      assert.doesNotMatch(
        surface.text,
        /reaches zero (?:weight )?at position 6|weight reaches zero at position 6/i,
        `${surface.label} must not claim 0-based position 6 has zero Strategic Risk weight`,
      );
      assert.match(
        surface.text,
        new RegExp(`(?:1-based )?position ${nextOneBasedPosition}[\\s\\S]{0,120}(?:0-based index ${nextZeroBasedIndex}[\\s\\S]{0,80})?(?:0\\.25|weight=0\\.25)`, 'i'),
        `${surface.label} must disclose that 1-based position 6 / 0-based index 5 would still carry 0.25 weight`,
      );
      assert.doesNotMatch(
        surface.text,
        /position 6[\s\S]{0,120}(?:0\.10|weight=0\.10)/i,
        `${surface.label} must not retain the off-by-one 0.10 position-6 example`,
      );
      assert.match(
        surface.text,
        /top-5 window|window cap|cap at 5/i,
        `${surface.label} must identify the explicit top-5 window as the bounding rule`,
      );
    }
  });

  it('section extraction ignores heading-looking lines inside fenced code blocks', () => {
    const section = markdownSection(
      [
        '### Target',
        'Before fence.',
        '```sh',
        '# install',
        '### not a section boundary',
        '```',
        'After fence.',
        '### Next',
        'Outside target.',
      ].join('\n'),
      '### Target',
    );

    assert.match(section, /### not a section boundary/);
    assert.match(section, /After fence\./);
    assert.doesNotMatch(section, /Outside target\./);
  });

  it('CII public docs publish UCDP newest-release behavior and classifier thresholds', () => {
    const methodologyDoc = readFileSync(resolve(root, 'docs/methodology/cii-risk-scores.mdx'), 'utf8');
    const countryDoc = readFileSync(resolve(root, 'docs/country-instability-index.mdx'), 'utf8');
    const algorithmsDoc = readFileSync(resolve(root, 'docs', 'algorithms.mdx'), 'utf8');
    assert.match(
      countryDoc,
      /^## Boosts And Floors$/m,
      'country-instability-index doc must keep the Boosts And Floors section heading used by UCDP threshold guards',
    );
    const countryFloors = markdownSection(countryDoc, '## Boosts And Floors');

    assert.match(
      methodologyDoc,
      /v8 amendment \(2026-06-07\)[\s\S]{0,260}newest GED[\s\S]{0,120}returns events[\s\S]{0,140}#4200/i,
      'methodology changelog must document the #4200 UCDP newest-release discovery amendment without a version bump',
    );
    assert.match(
      methodologyDoc,
      /ACLED returns zero events[\s\S]{0,80}comparison[\s\S]{0,20}windows/i,
      'methodology changelog must document the ACLED zero-event warning added with the v8 amendment',
    );
    assert.match(
      countryDoc,
      /conflict realtime\s+family is covered when either ACLED or an in-window UCDP feed is present/i,
      'country-instability-index doc must publish ACLED-or-UCDP health coverage semantics',
    );
    assert.match(
      countryDoc,
      /`COVERAGE_PARTIAL` only when ACLED is dark and UCDP is also absent, stale, or\s+outside the 2-year scoring window/i,
      'country-instability-index doc must not imply ACLED auth missing alone causes COVERAGE_PARTIAL',
    );
    assert.match(
      methodologyDoc,
      /Country Instability Index[\s\S]{0,120}ACLED-or-UCDP health coverage semantics/i,
      'methodology changelog must cross-link the current ACLED-or-UCDP health coverage semantics',
    );
    for (const surface of [
      { label: 'country-instability-index doc', text: countryFloors },
      { label: 'algorithms doc', text: algorithmsDoc },
    ]) {
      assert.match(
        surface.text,
        /2-year[\s\S]{0,240}(?:total\s+deaths (?:are\s+)?greater than 1000|total\s+deaths > 1000)[\s\S]{0,120}(?:event\s+count (?:is\s+)?greater than 100|event\s+count > 100)/i,
        `${surface.label} must publish the UCDP war thresholds`,
      );
      assert.match(
        surface.text,
        /(?:minor conflict|UCDP \*\*minor conflict\*\*)[\s\S]{0,160}(?:event\s+count (?:is\s+)?greater than 10|event\s+count > 10)/i,
        `${surface.label} must publish the UCDP minor-conflict threshold`,
      );
    }
  });

  it('algorithms doc separates authoritative Strategic Risk from local fallback', () => {
    const doc = readFileSync(resolve(root, 'docs', 'algorithms.mdx'), 'utf8');
    const section = markdownSection(doc, '### Strategic Risk Score Algorithm');

    assert.match(
      section,
      /authoritative `StrategicRisk\[0\]` score is the server roll-up of the top(?: five|-5) CII `combinedScore` values with weights `\[1\.00, 0\.85, 0\.70, 0\.55, 0\.40\]`, scale factor `0\.70`, floor `15`/i,
      'algorithms doc must identify the server roll-up as authoritative Strategic Risk',
    );
    assert.match(
      section,
      /server severity bands High >= 70, Medium 40-69, Low < 40/i,
      'algorithms doc must publish current server Strategic Risk severity bands',
    );
    assert.match(
      section,
      /Browser\/local fallback composite formula[\s\S]*`ciiRiskScore` — Local fallback only:[\s\S]*`\[0\.40, 0\.25, 0\.20, 0\.10, 0\.05\]`/,
      'algorithms doc may describe old additive weights only as local fallback',
    );
    assert.doesNotMatch(
      section,
      /`ciiRiskScore` — Top 5 countries by CII score, weighted `\[0\.40, 0\.25, 0\.20, 0\.10, 0\.05\]`/,
      'algorithms doc must not present the old fallback CII weights as canonical',
    );
    assert.doesNotMatch(
      section,
      /Critical\/Elevated\/Moderate|70\/50\/30/,
      'algorithms Strategic Risk section must not reintroduce old four-band risk semantics',
    );
  });

  it('public and developer surfaces do not retain stale CII, CRI, or platform-count claims', () => {
    const surfaces = [
      { label: 'public/llms.txt', text: readFileSync(resolve(root, 'public', 'llms.txt'), 'utf8') },
      { label: 'public/llms-full.txt', text: readFileSync(resolve(root, 'public', 'llms-full.txt'), 'utf8') },
      { label: 'docs/PRESS_KIT.md', text: readFileSync(resolve(root, 'docs', 'PRESS_KIT.md'), 'utf8') },
      { label: 'docs/COMMUNITY-PROMOTION-GUIDE.md', text: readFileSync(resolve(root, 'docs', 'COMMUNITY-PROMOTION-GUIDE.md'), 'utf8') },
      { label: 'AGENTS.md', text: readFileSync(resolve(root, 'AGENTS.md'), 'utf8') },
    ];

    for (const surface of surfaces) {
      assert.doesNotMatch(
        surface.text,
        /\bCountry Instability Index\b[\s\S]{0,240}\b22\s+(?:monitored\s+)?(?:nations|countries)\b/i,
        `${surface.label} must not retain the old 22-country CII count`,
      );
      assert.doesNotMatch(
        surface.text,
        /Baseline risk\s*\(40%\)[\s\S]{0,220}(?:Social unrest|unrest events)\s*\(20%\)[\s\S]{0,220}(?:Security events|security activity)\s*\(20%\)[\s\S]{0,220}Information velocity\s*\(20%\)/i,
        `${surface.label} must not publish the old 40/20/20/20 CII shortcut as current methodology`,
      );
      assert.doesNotMatch(
        surface.text,
        /\b(?:150|435)\+\s+(?:curated\s+)?(?:RSS\s+)?(?:news\s+)?feeds\b|\b(?:35|45|50)\+\s+(?:interactive\s+)?(?:map\s+)?(?:data\s+)?layers\b|\b(?:14|19|21)\s+languages\b/i,
        `${surface.label} must not retain stale feed, layer, or language counts`,
      );
    }

    const llmsBrief = surfaces[0]!.text;
    const llmsFull = surfaces[1]!.text;
    const pressKit = surfaces[2]!.text;
    const communityGuide = surfaces[3]!.text;
    const agentsGuide = surfaces[4]!.text;

    assert.match(llmsBrief, /CII v8[\s\S]{0,80}31 Tier-1 countries/i);
    assert.match(llmsBrief, /CRI[\s\S]{0,120}196-country public rankable universe/i);
    assert.match(llmsBrief, /six specialized variants/i);
    assert.match(llmsBrief, /56 map layer types/i);
    assert.match(llmsBrief, /500\+ curated RSS feeds/i);
    assert.match(llmsBrief, /25 languages/i);
    assert.match(llmsFull, /Country Instability Index \(CII v8\)[\s\S]{0,240}31 Tier-1 countries/i);
    assert.match(llmsFull, /eventScore = unrest \* 0\.25 \+ conflict \* 0\.30 \+ security \* 0\.20 \+ information \* 0\.25/i);
    assert.match(llmsFull, /Country Resilience Index \(CRI\)[\s\S]{0,160}196-country public rankable universe/i);
    assert.match(llmsFull, /six specialized variants/i);
    assert.match(llmsFull, /56 map layer types/i);
    assert.match(llmsFull, /500\+ RSS feeds/i);
    assert.match(llmsFull, /25 languages/i);
    assert.match(pressKit, /server-authoritative CII v8[\s\S]{0,120}31 Tier-1 countries/i);
    assert.match(pressKit, /Country Resilience Index[\s\S]{0,140}196-country public rankable universe/i);
    assert.match(pressKit, /six thematic variants/i);
    assert.match(pressKit, /56 map layer types/i);
    assert.match(pressKit, /500\+ RSS feeds/i);
    assert.match(pressKit, /24 \(including RTL\)/i);
    assert.match(communityGuide, /six specialized views/i);
    assert.match(agentsGuide, /`energy`:\s+Energy security/i);
    assert.doesNotMatch(
      `${llmsFull}\n${communityGuide}\n${agentsGuide}`,
      /Tri-Variant Build System|Three Variant Dashboards|three specialized variants|tri-variant architecture|three specialized views/i,
    );
  });
});
