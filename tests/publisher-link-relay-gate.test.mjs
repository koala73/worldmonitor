// #8398: the relay-side publisher-link gate duplicates the curated family
// domain table (CJS, dependency-free — the relay boots on require) and the
// shared link predicate (shared/publisher-link-gate.js). This pins both the
// behavioral contract and the table sync.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  gateRelayStoryLink,
  PUBLISHER_LINK_DOMAINS,
} = require('../scripts/lib/publisher-link-relay-gate.cjs');

describe('publisher-link relay gate (#8398)', () => {
  it('keeps a link on the publisher family domain, blanks an off-publisher link', () => {
    assert.equal(
      gateRelayStoryLink('https://www.reuters.com/world/europe/x', 'reuters'),
      'https://www.reuters.com/world/europe/x',
    );
    assert.equal(gateRelayStoryLink('https://evil.example/phish', 'reuters'), '');
  });

  it('rejects lookalike suffixes', () => {
    assert.equal(gateRelayStoryLink('https://evilreuters.com/x', 'reuters'), '');
    assert.equal(gateRelayStoryLink('https://reuters.com.evil.com/x', 'reuters'), '');
  });

  it('fails closed for unlisted families, singletons, and empty links', () => {
    assert.equal(gateRelayStoryLink('https://example.com/a', 'label:example wire'), '');
    assert.equal(gateRelayStoryLink('https://example.com/a', 'no-such-family'), '');
    assert.equal(gateRelayStoryLink('https://example.com/a', ''), '');
    assert.equal(gateRelayStoryLink('', 'reuters'), '');
    assert.equal(gateRelayStoryLink('javascript:alert(1)', 'reuters'), '');
  });

  it('stays in sync with PUBLISHER_FAMILY_DOMAINS in shared/publisher-families.js', () => {
    const src = readFileSync(new URL('../shared/publisher-families.js', import.meta.url), 'utf8');
    const tableMatch = src.match(/const PUBLISHER_FAMILY_DOMAINS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
    assert.ok(tableMatch, 'curated domain table found in shared/publisher-families.js');
    const sharedTable = {};
    for (const [, family, domains] of tableMatch[1].matchAll(/'([^']+)': \[([^\]]*)\]/g)) {
      sharedTable[family] = domains.split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    }
    for (const [family, domains] of Object.entries(PUBLISHER_LINK_DOMAINS)) {
      assert.deepEqual(
        [...domains].sort(),
        [...(sharedTable[family] ?? [])].sort(),
        `relay table entry for '${family}' matches the shared table`,
      );
    }
    // Reverse direction: every shared-table family must exist in the relay
    // table, or the relay fails closed on a publisher ingest allows.
    for (const family of Object.keys(sharedTable)) {
      assert.ok(
        family in PUBLISHER_LINK_DOMAINS,
        `shared table family '${family}' missing from the relay table — relay would blank its links`,
      );
    }
  });

  it('resolves every domain-backed family label to its family (label-drift guard)', () => {
    // The relay gate resolves feed LABELS, not family ids. A new label for
    // a domain-backed family that lands in PUBLISHER_FAMILY_DATA but not in
    // the relay's PUBLISHER_LINK_LABELS would fail closed (blank link) while
    // ingest allows it — a silent divergence. Parse both tables from the
    // shared source and require full label coverage.
    const relay = require('../scripts/lib/publisher-link-relay-gate.cjs');
    const src = readFileSync(new URL('../shared/publisher-families.js', import.meta.url), 'utf8');
    const dataMatch = src.match(/const PUBLISHER_FAMILY_DATA = \{([\s\S]*?)\n\};/);
    assert.ok(dataMatch, 'curated family data found in shared/publisher-families.js');
    // Simpler: extract family ids that have a domain-table entry.
    const tableMatch = src.match(/const PUBLISHER_FAMILY_DOMAINS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
    const familiesWithDomains = new Set(
      [...tableMatch[1].matchAll(/'([^']+)': \[/g)].map(([, f]) => f),
    );
    const labelEntries = [...dataMatch[1].matchAll(/'([^']+)': \{ publisher: "[^"]*", labels: \[([^\]]*)\]/g)];
    const missing = [];
    for (const [, family, labelsRaw] of labelEntries) {
      if (!familiesWithDomains.has(family)) continue;
      const labels = [...labelsRaw.matchAll(/"([^"]+)"/g)].map(([, l]) => l);
      for (const label of labels) {
        const resolved = relay.familyForLabel(label);
        if (resolved !== family) {
          missing.push(`"${label}" resolves to "${resolved}", expected "${family}"`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it('keeps a WSJ link for the Dow Jones delivery-host feed label (#8398 review)', () => {
    // The WSJ feed URL is feeds.content.dowjones.io but item links point at
    // wsj.com. The relay only sees the feed label, so the publisher-name
    // index must resolve it to the domain-only 'wsj' family.
    assert.equal(
      gateRelayStoryLink('https://www.wsj.com/articles/markets-rally', 'Wall Street Journal'),
      'https://www.wsj.com/articles/markets-rally',
    );
    assert.equal(gateRelayStoryLink('https://evil.example/phish', 'Wall Street Journal'), '');
  });

  it('matches the shared predicate on sampled cases', async () => {
    const shared = await import('../shared/publisher-link-gate.js');
    const cases = [
      ['https://www.bbc.co.uk/news/x', ['bbc.co.uk'], true],
      ['https://evilbbc.co.uk/x', ['bbc.co.uk'], false],
      ['https://amp.theguardian.com/x', ['theguardian.com'], true],
      ['javascript:alert(1)', ['bbc.co.uk'], false],
    ];
    const relay = require('../scripts/lib/publisher-link-relay-gate.cjs');
    for (const [link, hosts, expected] of cases) {
      assert.equal(shared.isPublisherLink(link, hosts), expected, `shared: ${link}`);
      assert.equal(relay.isPublisherLink(link, hosts), expected, `relay: ${link}`);
    }
  });
});
