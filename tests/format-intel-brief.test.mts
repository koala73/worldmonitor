import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatIntelBrief, renderBriefEvidenceFooter } from '../src/utils/format-intel-brief';

describe('formatIntelBrief citations', () => {
  it('links bracket citations to source URLs when a source list is provided', () => {
    const html = formatIntelBrief('SITUATION NOW\nClaim one [1]. Claim two [2].', {
      sources: [
        { title: 'First source', url: 'https://example.com/first' },
        { title: 'Second source', url: 'https://example.com/second' },
      ],
    });

    assert.match(html, /href="https:\/\/example\.com\/first"/);
    assert.match(html, /href="https:\/\/example\.com\/second"/);
    assert.doesNotMatch(html, /href="#cb-news-2"/);
  });

  it('falls back to headline anchors only when no source list is provided', () => {
    const html = formatIntelBrief('SITUATION NOW\nClaim [2].', { count: 3, hrefPrefix: '#cb-news-' });

    assert.match(html, /href="#cb-news-2"/);
  });
});

describe('formatIntelBrief markdown and ISO headings', () => {
  it('converts emphasis markers inside bullets, not just paragraphs', () => {
    const html = formatIntelBrief(
      'WHAT THIS MEANS FOR NO\n• **Norges Bank Investment Management (NBIM)**: sale [1].',
      { sources: [{ title: 'CNBC', url: 'https://example.com/nbim' }] },
      'Norway',
    );
    assert.match(html, /<strong>Norges Bank Investment Management \(NBIM\)<\/strong>/);
    assert.doesNotMatch(html, /\*\*/);
  });

  it('rewrites ISO-code section titles to the country name', () => {
    const html = formatIntelBrief(
      'WHAT THIS MEANS FOR NO\nNamed infrastructure impact.',
      undefined,
      'Norway',
    );
    assert.match(html, /What this means for Norway/);
    assert.doesNotMatch(html, /\bFOR NO\b/);
  });

  it('recognizes section titles wrapped in markdown emphasis', () => {
    const html = formatIntelBrief(
      '**WHAT THIS MEANS FOR GE**\nNamed infrastructure impact.',
      undefined,
      'Georgia',
    );
    assert.match(html, /What this means for Georgia/);
    assert.doesNotMatch(html, /\bFOR GE\b/);
  });

  it('strips markdown heading markers before rewriting ISO titles', () => {
    const html = formatIntelBrief(
      '# WHAT THIS MEANS FOR NO\n* **NBIM**: sale.',
      undefined,
      'Norway',
    );
    assert.match(html, /What this means for Norway/);
    assert.match(html, /<strong>NBIM<\/strong>/);
    assert.doesNotMatch(html, /\bFOR NO\b/);
  });

  it('unwraps combined heading markers before rewriting ISO titles', () => {
    const html = formatIntelBrief(
      '### **WHAT THIS MEANS FOR NO**\nNamed infrastructure impact.',
      undefined,
      'Norway',
    );
    assert.match(html, /What this means for Norway/);
    assert.doesNotMatch(html, /\bFOR NO\b/);
  });
});

describe('formatIntelBrief evidence citations and whole-line headings', () => {
  const evidence = [
    { id: 'E1', label: 'Unsafe link', value: '12', asOf: '2026-09-20T00:00:00.000Z', url: 'javascript:alert(1)' },
    { id: 'E2', label: 'Fiscal space', value: '28 of 100', asOf: '2026-09-21T00:00:00.000Z', url: 'https://www.worldmonitor.app/resilience/fi' },
    { id: 'E3', label: 'Energy <mix>', value: '"quoted"', asOf: '2026-09-21T00:00:00.000Z', url: '' },
  ];

  it('renders an [En] marker as an evidence reference linked to its evidence item', () => {
    const html = formatIntelBrief(
      "SITUATION NOW\nFinland's fiscal space scores 28 of 100 in the Country Resilience Index. [E2]",
      undefined,
      'Finland',
      evidence,
    );
    assert.match(html, /<a href="https:\/\/www\.worldmonitor\.app\/resilience\/fi"[^>]*class="cb-citation cb-evidence-citation"[^>]*>\[E2\]<\/a>/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /title="Fiscal space: 28 of 100 \(as of 2026-09-21\)"/);
  });

  it('keeps headline and evidence markers distinct on the same claim', () => {
    const html = formatIntelBrief(
      'SITUATION NOW\nClaim with both. [1][E2]',
      { sources: [{ title: 'Headline', url: 'https://example.com/one' }] },
      undefined,
      evidence,
    );
    assert.match(html, /href="https:\/\/example\.com\/one"[^>]*>\[1\]<\/a>/);
    assert.match(html, /class="cb-citation cb-evidence-citation"[^>]*>\[E2\]<\/a>/);
  });

  it('never renders a javascript: evidence URL as a link', () => {
    const html = formatIntelBrief('SITUATION NOW\nUnsafe claim. [E1]', undefined, undefined, evidence);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /<a [^>]*>\[E1\]<\/a>/);
    assert.match(html, /<span class="cb-evidence-citation" title="Unsafe link: 12 \(as of 2026-09-20\)">\[E1\]<\/span>/);
  });

  it('escapes evidence text inside the tooltip', () => {
    const html = formatIntelBrief('SITUATION NOW\nEnergy claim. [E3]', undefined, undefined, evidence);
    assert.match(html, /title="Energy &lt;mix&gt;: &quot;quoted&quot; \(as of 2026-09-21\)"/);
  });

  it('does not inject evidence markup into a source title attribute', () => {
    const html = formatIntelBrief(
      'SITUATION NOW\nClaim. [1]',
      { sources: [{ title: 'Headline citing [E2]', url: 'https://example.com/one' }] },
      undefined,
      evidence,
    );
    assert.match(html, /title="Headline citing \[E2\]">\[1\]<\/a>/);
  });

  it('leaves an unknown evidence marker as plain text', () => {
    const html = formatIntelBrief('SITUATION NOW\nClaim. [E9]', undefined, undefined, evidence);
    assert.match(html, /Claim\. \[E9\]/);
    assert.doesNotMatch(html, /cb-evidence-citation/);
  });

  it('does not treat a body line beginning "Outlook for" as a section header', () => {
    const html = formatIntelBrief(
      'SITUATION NOW\nOutlook for exports weakened after the port closure. [1]',
      { sources: [{ title: 'Headline', url: 'https://example.com/one' }] },
    );
    assert.equal((html.match(/brief-section-header/g) ?? []).length, 1);
    assert.match(html, /<div class="brief-para">Outlook for exports weakened/);
  });

  it('does not treat a body line beginning "Key risks include" as a header', () => {
    const html = formatIntelBrief('SITUATION NOW\nKey risks include a budget impasse.');
    assert.equal((html.match(/brief-section-header/g) ?? []).length, 1);
  });

  it('renders a Situation-only brief with no empty headers', () => {
    const html = formatIntelBrief('SITUATION NOW\nOnly claim. [E2]', undefined, 'Finland', evidence);
    assert.equal((html.match(/brief-section-header/g) ?? []).length, 1);
    assert.match(html, /brief-section-header">SITUATION NOW</);
    assert.doesNotMatch(html, /KEY RISKS|OUTLOOK|WATCH ITEMS|What this means/i);
  });

  it('still recognizes every whole heading line, including a full-name WHAT THIS MEANS FOR', () => {
    const html = formatIntelBrief(
      'SITUATION NOW\nA.\n\nWHAT THIS MEANS FOR FINLAND\nB.\n\nKEY RISKS\nC.\n\nOUTLOOK\nD.\n\nWATCH ITEMS\nE.',
      undefined,
      'Finland',
    );
    assert.equal((html.match(/brief-section-header/g) ?? []).length, 5);
    assert.match(html, /What this means for Finland/);
  });
});

describe('renderBriefEvidenceFooter', () => {
  it('lists evidence with label, value, as-of date and a sanitized link', () => {
    const html = renderBriefEvidenceFooter([
      { id: 'E1', label: 'Unsafe <b>', value: '12', asOf: '2026-09-20T00:00:00.000Z', url: 'javascript:alert(1)' },
      { id: 'E2', label: 'Fiscal space', value: '28 of 100', asOf: '2026-09-21T00:00:00.000Z', url: 'https://www.worldmonitor.app/resilience/fi' },
    ], { className: 'cb-brief-sources cb-brief-evidence' });
    assert.match(html, /<details class="cb-brief-sources cb-brief-evidence">/);
    assert.match(html, /<summary>World Monitor data \(2\)<\/summary>/);
    assert.match(html, /<a href="https:\/\/www\.worldmonitor\.app\/resilience\/fi" target="_blank" rel="noopener noreferrer">Fiscal space<\/a>/);
    assert.match(html, /28 of 100/);
    assert.match(html, /2026-09-21/);
    assert.match(html, /\[E2\]/);
    assert.doesNotMatch(html, /javascript:/i);
    assert.match(html, /Unsafe &lt;b&gt;/);
  });

  it('renders nothing for an empty or missing list', () => {
    assert.equal(renderBriefEvidenceFooter([]), '');
    assert.equal(renderBriefEvidenceFooter(undefined), '');
  });
});
