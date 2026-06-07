import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';

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

describe('CII docs drift guards', () => {
  it('internal review docs do not retain stale CII country-count or source-of-truth claims', () => {
    const internalDocPaths = [
      'docs/Docs_To_Review/todo_docs.md',
      'docs/Docs_To_Review/todo.md',
      'docs/Docs_To_Review/TODO_Performance.md',
      'docs/Docs_To_Review/COMPONENTS.md',
    ];
    const staleCiiFormulaVersionClaim = new RegExp(
      String.raw`\bCII\s+(?!${CII_FORMULA_VERSION}\b)v\d+\s+(?:stability|stress|instability|scores?|scoring|formula)\b`,
      'i',
    );
    const stalePublishedCiiVersionClaim = new RegExp(
      String.raw`\b(?:server-authoritative|published)\s+CII\s+(?:is\s+)?(?:server-authoritative\s+)?(?!${CII_FORMULA_VERSION}\b)v\d+\b`,
      'i',
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

  it('strategic risk doc publishes current server severity bands and roll-up', () => {
    const doc = readFileSync(resolve(root, 'docs', 'strategic-risk.mdx'), 'utf8');
    const scoreSection = markdownSection(doc, '### Server Score and Browser Fallback (0-100)');
    const riskLevels = markdownSection(doc, '### Risk Levels');

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
    assert.match(riskLevels, /\|\s*70-100\s*\|\s*\*\*High\*\*/);
    assert.match(riskLevels, /\|\s*40-69\s*\|\s*\*\*Medium\*\*/);
    assert.match(riskLevels, /\|\s*0-39\s*\|\s*\*\*Low\*\*/);
    assert.doesNotMatch(
      riskLevels,
      /\*\*(?:Critical|Elevated|Moderate)\*\*|50-69|30-49/,
      'strategic-risk risk-level table must not retain old Critical/Elevated/Moderate 70/50/30 semantics',
    );
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
});
