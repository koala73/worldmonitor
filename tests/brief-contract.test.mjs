// #4921: the brief contract — top-8 synthesis prompts/parser, mechanical
// citation verification, the grounding spine port, and wiring assertions.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  synthesisSystemPrompt,
  synthesisUserPrompt,
  parseBriefSynthesis,
} from '../scripts/_insights-brief.mjs';
import {
  verifyCitationIndexes,
  checkLeadGrounding,
  leadGroundsAgainstStory,
  extractAnchorTokens,
} from '../shared/brief-llm-core.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(resolve(root, rel), 'utf-8');

const STORIES = [
  { primaryTitle: 'Iran threatens to close Strait of Hormuz', primarySource: 'Reuters', sources: ['Reuters', 'BBC'] },
  { primaryTitle: 'Turkey hikes interest rates to 50%', primarySource: 'Bloomberg', sources: ['Bloomberg'] },
  { primaryTitle: 'Magnitude 6.8 earthquake strikes northern Chile', primarySource: 'AP', sources: ['AP', 'AFP', 'CNN'] },
];

describe('synthesis prompts (#4921)', () => {
  it('system prompt demands JSON, per-story lines, citations, and no invention', () => {
    const prompt = synthesisSystemPrompt('2026-07-06');
    assert.match(prompt, /JSON ONLY/);
    assert.match(prompt, /one entry per numbered story/);
    assert.match(prompt, /\[n\]|\[1\]/);
    assert.match(prompt, /Do not invent proper nouns/);
    assert.match(prompt, /ONLY facts present/);
  });

  it('user prompt numbers every story with source counts', () => {
    const prompt = synthesisUserPrompt(STORIES);
    assert.match(prompt, /1\. Iran threatens to close Strait of Hormuz \(Reuters, 2 sources\)/);
    assert.match(prompt, /2\. Turkey hikes interest rates to 50% \(Bloomberg, 1 source\)/);
    assert.match(prompt, /3\. Magnitude 6\.8 earthquake/);
  });
});

describe('parseBriefSynthesis (#4921)', () => {
  const VALID = JSON.stringify({
    lead: 'Iran escalates around Hormuz [1] while Turkey moves rates sharply higher [2] and Chile digs out from a major quake [3].',
    lines: [
      { n: 1, text: 'Iran threatens to close the Strait of Hormuz [1].' },
      { n: 2, text: 'Turkey raises interest rates to 50% [2].' },
      { n: 3, text: 'A 6.8-magnitude earthquake strikes northern Chile [3].' },
    ],
  });

  it('parses clean JSON', () => {
    const out = parseBriefSynthesis(VALID, 3);
    assert.ok(out);
    assert.equal(out.lines.length, 3);
    assert.match(out.lead, /Hormuz/);
  });

  it('strips markdown fences (groq/Gemini wrap)', () => {
    const out = parseBriefSynthesis('```json\n' + VALID + '\n```', 3);
    assert.ok(out, 'fenced JSON must parse');
  });

  it('tolerates prose around the JSON object', () => {
    const out = parseBriefSynthesis('Here is the brief:\n' + VALID + '\nHope that helps!', 3);
    assert.ok(out);
  });

  it('rejects out-of-range and duplicate line indexes, keeps valid ones', () => {
    const messy = JSON.stringify({
      lead: 'Iran and Turkey dominate the day with Hormuz tension and a sharp rate move [1][2].',
      lines: [
        { n: 0, text: 'Out of range line that should be discarded entirely.' },
        { n: 1, text: 'Iran threatens to close the Strait of Hormuz [1].' },
        { n: 1, text: 'Duplicate index must not override the first entry.' },
        { n: 9, text: 'Also out of range for a 3-story brief input.' },
        { n: 2, text: 'Turkey raises interest rates to 50% [2].' },
      ],
    });
    const out = parseBriefSynthesis(messy, 3);
    assert.ok(out);
    assert.deepEqual(out.lines.map((l) => l.n), [1, 2]);
    assert.match(out.lines[0].text, /Hormuz/);
  });

  it('returns null when fewer than half the stories have usable lines', () => {
    const thin = JSON.stringify({
      lead: 'A lead that is long enough to pass the basic length validation gate here.',
      lines: [{ n: 1, text: 'Only one usable line for an eight-story brief input.' }],
    });
    assert.equal(parseBriefSynthesis(thin, 8), null);
  });

  it('returns null on garbage and on missing lead', () => {
    assert.equal(parseBriefSynthesis('not json at all', 3), null);
    assert.equal(parseBriefSynthesis(JSON.stringify({ lines: [] }), 3), null);
  });
});

describe('verifyCitationIndexes (#4921)', () => {
  it('keeps in-range citations, strips invented ones', () => {
    const { text, stripped } = verifyCitationIndexes('Tension rises [1] as markets react [7] to the move [2].', 3);
    assert.equal(stripped, 1);
    assert.match(text, /\[1\]/);
    assert.match(text, /\[2\]/);
    assert.doesNotMatch(text, /\[7\]/);
  });

  it('zero sources strips every citation', () => {
    const { text, stripped } = verifyCitationIndexes('Claim [1] and claim [2].', 0);
    assert.equal(stripped, 2);
    assert.doesNotMatch(text, /\[\d\]/);
  });

  it('non-string input degrades safely', () => {
    assert.deepEqual(verifyCitationIndexes(null, 3), { text: '', stripped: 0 });
  });
});

describe('grounding spine port (#4921)', () => {
  it('core exports work standalone with the cap parameter', () => {
    const stories = STORIES.map((s) => ({ headline: s.primaryTitle }));
    assert.equal(checkLeadGrounding({ lead: 'Iran moves on Hormuz as Turkey acts.' }, stories, 8), true);
    assert.equal(
      checkLeadGrounding({ lead: 'President Biden announced a crypto executive order today.' }, stories, 8),
      false,
      'fabricated lead must fail grounding',
    );
    assert.equal(leadGroundsAgainstStory('Iran escalates', 'Iran threatens to close Strait of Hormuz'), true);
    assert.ok(extractAnchorTokens('Iran threatens Hormuz closure').includes('iran'));
  });

  it('brief-llm.mjs re-exports the core implementation (no drift possible)', async () => {
    const lib = await import('../scripts/lib/brief-llm.mjs');
    const core = await import('../shared/brief-llm-core.js');
    assert.equal(lib.checkLeadGrounding, core.checkLeadGrounding, 'must be the SAME function object');
    assert.equal(lib.leadGroundsAgainstStory, core.leadGroundsAgainstStory);
  });
});

describe('brief-contract wiring (source-textual)', () => {
  it('seed-insights runs the synthesis path through the pure composer with enforce-by-default', () => {
    const src = readSrc('scripts/seed-insights.mjs');
    assert.match(src, /synthesisSystemPrompt/);
    assert.match(src, /composeSynthesizedBrief\(synthesisResult\.text, topStories, \{/);
    assert.match(src, /validatorMode: BRIEF_VALIDATOR_MODE/);
    assert.match(src, /=== 'shadow' \? 'shadow' : 'enforce'/, 'enforce must be the default mode');
    assert.match(src, /generateLegacySingleHeadlineBrief\(topStories\)/, 'L2 fallback must be wired');
    assert.match(src, /briefStoryLines/);
    assert.match(src, /sourceAgeRange/);
  });

  it('country-intel brief strips invented citations before shipping', () => {
    const src = readSrc('server/worldmonitor/intelligence/v1/get-country-intel-brief.ts');
    assert.match(src, /verifyCitationIndexes\(llmResult\.content, entrySources\.length\)/);
    assert.match(src, /brief: citationCheck\.text/);
  });

  it('panel renders story lines and the freshness footer', () => {
    const src = readSrc('src/components/InsightsPanel.ts');
    assert.match(src, /renderBriefExtras/);
    assert.match(src, /insights-brief-lines/);
    assert.match(src, /components\.insights\.briefFreshness/);
  });

  it('core and mirrors are byte-identical (grounding spine included)', () => {
    assert.equal(readSrc('shared/brief-llm-core.js'), readSrc('scripts/shared/brief-llm-core.js'));
    assert.equal(readSrc('shared/brief-llm-core.d.ts'), readSrc('scripts/shared/brief-llm-core.d.ts'));
  });
});

// ── #4928 review-round additions ───────────────────────────────────────────

import { composeSynthesizedBrief } from '../scripts/_insights-brief.mjs';

describe('composeSynthesizedBrief (functional L1 coverage, #4928 review)', () => {
  const CORROBORATED = [
    { primaryTitle: 'Iran threatens to close Strait of Hormuz', primarySource: 'Reuters', primaryLink: 'https://r/1', pubDate: '2026-07-06T01:00:00Z', sources: ['Reuters', 'BBC'] },
    { primaryTitle: 'Turkey hikes interest rates to 50%', primarySource: 'Bloomberg', primaryLink: 'https://b/2', pubDate: '2026-07-06T02:00:00Z', sources: ['Bloomberg'] },
  ];
  const GOOD = JSON.stringify({
    lead: 'Iran raises the stakes around Hormuz [1] while Turkey delivers a dramatic rate hike [2].',
    lines: [
      { n: 1, text: 'Iran threatens to close the Strait of Hormuz [1].' },
      { n: 2, text: 'Turkey raises interest rates to 50% [2].' },
    ],
  });
  const passOpts = { validatorMode: 'enforce', sourceFromStory: (s) => ({ title: s.primaryTitle, source: s.primarySource, url: s.primaryLink }) };

  it('happy path: lead + locked lines + lockstep sources', () => {
    const out = composeSynthesizedBrief(GOOD, CORROBORATED, passOpts);
    assert.ok(out);
    assert.match(out.lead, /Hormuz \[1\]/);
    assert.equal(out.lines.length, 2);
    assert.equal(out.sources.length, 2);
    assert.equal(out.sources[1].url, 'https://b/2');
  });

  it('REGRESSION: a story without a usable link gets a substitute source entry, never shifting [n] mapping', () => {
    const out = composeSynthesizedBrief(GOOD, CORROBORATED, {
      ...passOpts,
      sourceFromStory: (s) => (s.primarySource === 'Reuters' ? null : { title: s.primaryTitle, source: s.primarySource, url: s.primaryLink }),
    });
    assert.ok(out);
    assert.equal(out.sources.length, 2, 'sources must stay index-locked');
    assert.equal(out.sources[0].url, '', 'missing link → substitute entry, not filtered');
    assert.equal(out.sources[1].url, 'https://b/2', '[2] still points at story 2');
  });

  it('editorial gate: all-single-source days reject L1 (legacy corroboration bar preserved)', () => {
    const singles = CORROBORATED.map((s) => ({ ...s, sources: [s.primarySource] }));
    assert.equal(composeSynthesizedBrief(GOOD, singles, passOpts), null);
  });

  it('lead inventing a proper noun is rejected in enforce mode (falls back)', () => {
    const fabricated = JSON.stringify({
      lead: 'President Macron condemned the Hormuz escalation [1] as Turkey hiked rates [2].',
      lines: [
        { n: 1, text: 'Iran threatens to close the Strait of Hormuz [1].' },
        { n: 2, text: 'Turkey raises interest rates to 50% [2].' },
      ],
    });
    assert.equal(composeSynthesizedBrief(fabricated, CORROBORATED, passOpts), null);
  });

  it('a line inventing a proper noun degrades to its headline WITH its citation', () => {
    const badLine = JSON.stringify({
      lead: 'Iran raises the stakes around Hormuz [1] while Turkey delivers a dramatic rate hike [2].',
      lines: [
        { n: 1, text: 'Ayatollah Nasrallah vows to close the Strait of Hormuz [1].' },
        { n: 2, text: 'Turkey raises interest rates to 50% [2].' },
      ],
    });
    const out = composeSynthesizedBrief(badLine, CORROBORATED, passOpts);
    assert.ok(out);
    assert.equal(out.hallucinatedLines, 1);
    assert.equal(out.lines[0].text, 'Iran threatens to close Strait of Hormuz [1]', 'degraded line keeps [n]');
  });

  it('missing line fills from headline with its citation', () => {
    const partial = JSON.stringify({
      lead: 'Iran raises the stakes around Hormuz [1] while Turkey delivers a dramatic rate hike [2].',
      lines: [{ n: 1, text: 'Iran threatens to close the Strait of Hormuz [1].' }],
    });
    const out = composeSynthesizedBrief(partial, CORROBORATED, passOpts);
    assert.ok(out);
    assert.match(out.lines[1].text, /\[2\]$/);
  });
});

describe('boundary + contract pins (#4928 review)', () => {
  it('parser lead-length bounds are inclusive at 40 and 700', () => {
    const mk = (leadLen) => JSON.stringify({
      lead: 'L'.repeat(leadLen),
      lines: [{ n: 1, text: 'A perfectly reasonable line for story one [1].' }],
    });
    assert.ok(parseBriefSynthesis(mk(40), 1), '40-char lead must pass');
    assert.ok(parseBriefSynthesis(mk(700), 1), '700-char lead must pass');
    assert.equal(parseBriefSynthesis(mk(39), 1), null);
    assert.equal(parseBriefSynthesis(mk(701), 1), null);
  });

  it('system prompt pins the exact JSON keys the parser reads', () => {
    const prompt = synthesisSystemPrompt('2026-07-06');
    for (const key of ['"lead"', '"lines"', '"n"', '"text"']) {
      assert.ok(prompt.includes(key), `prompt must name ${key} — parser depends on it`);
    }
  });

  it('verifyCitationIndexes catches 3-digit invented markers, leaves 4-digit prose alone', () => {
    const { text, stripped } = verifyCitationIndexes('Claim [123] and year [2026] and real [1].', 2);
    assert.equal(stripped, 1, '[123] stripped');
    assert.match(text, /\[2026\]/, 'bracketed years are prose, not citations');
    assert.match(text, /\[1\]/);
  });
});

// ── #4928 external-review round ────────────────────────────────────────────

describe('citation-scoped composer gates (#4928 external review)', () => {
  const STORIES2 = [
    { primaryTitle: 'Iran threatens to close Strait of Hormuz', primarySource: 'Reuters', primaryLink: 'https://r/1', pubDate: '2026-07-06T01:00:00Z', sources: ['Reuters', 'BBC'] },
    { primaryTitle: 'Turkey hikes interest rates to 50%', primarySource: 'Bloomberg', primaryLink: 'https://b/2', pubDate: '2026-07-06T02:00:00Z', sources: ['Bloomberg'] },
  ];
  const passOpts = { validatorMode: 'enforce', sourceFromStory: (s) => ({ title: s.primaryTitle, source: s.primarySource, url: s.primaryLink }) };

  it('REGRESSION: a lead sentence attributing story-2 facts to [1] is rejected (misattribution)', () => {
    const misattributed = JSON.stringify({
      lead: 'Turkey hikes interest rates to 50% in a dramatic move [1]. Iran threatens the Strait of Hormuz [1].',
      lines: [
        { n: 1, text: 'Iran threatens to close the Strait of Hormuz [1].' },
        { n: 2, text: 'Turkey raises interest rates to 50% [2].' },
      ],
    });
    assert.equal(composeSynthesizedBrief(misattributed, STORIES2, passOpts), null,
      'Turkey facts cited to [1] (Iran) must fail citation-scoped validation');
  });

  it('REGRESSION: an uncited lead sentence rejects the synthesis (every claim cited)', () => {
    const uncited = JSON.stringify({
      lead: 'Iran threatens the Strait of Hormuz [1]. Markets everywhere are nervous about what comes next.',
      lines: [
        { n: 1, text: 'Iran threatens to close the Strait of Hormuz [1].' },
        { n: 2, text: 'Turkey raises interest rates to 50% [2].' },
      ],
    });
    assert.equal(composeSynthesizedBrief(uncited, STORIES2, passOpts), null);
  });

  it('REGRESSION: a line carrying the WRONG in-range citation is rewritten to its own [n]', () => {
    const wrongCite = JSON.stringify({
      lead: 'Iran raises the stakes around Hormuz [1] while Turkey delivers a dramatic rate hike [2].',
      lines: [
        { n: 1, text: 'Iran threatens to close the Strait of Hormuz [1].' },
        { n: 2, text: 'Turkey raises interest rates to 50% [1].' },
      ],
    });
    const out = composeSynthesizedBrief(wrongCite, STORIES2, passOpts);
    assert.ok(out);
    assert.match(out.lines[1].text, /\[2\]$/, 'line 2 must end with [2], never [1]');
    assert.doesNotMatch(out.lines[1].text.replace(/\[2\]$/, ''), /\[\d+\]/, 'foreign citations stripped');
  });

  it('REGRESSION: a line with no surviving citation still ends with its own [n]', () => {
    const uncitedLine = JSON.stringify({
      lead: 'Iran raises the stakes around Hormuz [1] while Turkey delivers a dramatic rate hike [2].',
      lines: [
        { n: 1, text: 'Iran threatens to close the Strait of Hormuz [9].' },
        { n: 2, text: 'Turkey raises interest rates to 50% [2].' },
      ],
    });
    const out = composeSynthesizedBrief(uncitedLine, STORIES2, passOpts);
    assert.ok(out);
    assert.match(out.lines[0].text, /\[1\]$/);
  });
});

describe('balanced-brace extraction (#4928 external review P3)', () => {
  it('a stray closing brace in trailing prose no longer defeats the parse', () => {
    const withStray = JSON.stringify({
      lead: 'Iran escalates around Hormuz [1] and markets brace for the fallout of it all [1].',
      lines: [{ n: 1, text: 'Iran threatens to close the Strait of Hormuz [1].' }],
    }) + '\nHope that helps! (edge case: })';
    assert.ok(parseBriefSynthesis(withStray, 1), 'stray } after the object must not break extraction');
  });

  it('braces inside JSON strings do not confuse the scanner', () => {
    const withInnerBrace = JSON.stringify({
      lead: 'Iran { escalates } around Hormuz [1] and markets brace for the fallout today [1].',
      lines: [{ n: 1, text: 'Iran threatens to close the Strait of Hormuz [1].' }],
    });
    assert.ok(parseBriefSynthesis(withInnerBrace, 1));
  });
});
