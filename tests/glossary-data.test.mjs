import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GLOSSARY_TERMS, GLOSSARY_CATEGORIES } from '../blog-site/src/data/glossary.ts';

// The glossary (#4960) renders one crawlable DefinedTerm page per entry under
// /blog/glossary. These guards keep the data self-consistent (every related
// slug resolves, every category is real) so the Astro getStaticPaths fan-out
// and the DefinedTermSet JSON-LD never point at a 404, and enforce the
// no-invented-capabilities rule that applies to every agent-facing surface.

describe('glossary data integrity', () => {
  const slugs = GLOSSARY_TERMS.map((t) => t.slug);
  const slugSet = new Set(slugs);

  it('has a non-trivial number of terms', () => {
    assert.ok(GLOSSARY_TERMS.length >= 15, `expected >= 15 terms, got ${GLOSSARY_TERMS.length}`);
  });

  it('every slug is unique and URL-safe', () => {
    assert.equal(slugSet.size, slugs.length, 'duplicate slug(s) present');
    for (const slug of slugs) {
      assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `slug not URL-safe: ${slug}`);
    }
  });

  it('every term carries the required fields', () => {
    for (const t of GLOSSARY_TERMS) {
      assert.ok(t.term && typeof t.term === 'string', `missing term for ${t.slug}`);
      assert.ok(t.short && t.short.length >= 40, `short definition too thin for ${t.slug}`);
      assert.ok(Array.isArray(t.body) && t.body.length >= 1, `missing body for ${t.slug}`);
      assert.ok(Array.isArray(t.related), `related must be an array for ${t.slug}`);
    }
  });

  it('the short definition restates the term (answer-block shape)', () => {
    // AEO/citation surfaces read the first sentence as a standalone answer;
    // it should name the thing it defines, not open with a pronoun.
    for (const t of GLOSSARY_TERMS) {
      const needle = (t.abbr || t.term.split(' ')[0]).toLowerCase();
      assert.ok(
        t.short.toLowerCase().includes(needle),
        `short definition for ${t.slug} should name the term (looked for "${needle}")`
      );
    }
  });

  it('every category is one of the declared categories', () => {
    const valid = new Set(GLOSSARY_CATEGORIES);
    for (const t of GLOSSARY_TERMS) {
      assert.ok(valid.has(t.category), `unknown category "${t.category}" on ${t.slug}`);
    }
  });

  it('every related slug resolves to another term', () => {
    for (const t of GLOSSARY_TERMS) {
      for (const rel of t.related) {
        assert.ok(slugSet.has(rel), `${t.slug} references unknown related slug "${rel}"`);
        assert.notEqual(rel, t.slug, `${t.slug} lists itself as related`);
      }
    }
  });

  it('learnMore links are absolute https URLs', () => {
    for (const t of GLOSSARY_TERMS) {
      for (const link of t.learnMore ?? []) {
        assert.ok(link.label, `learnMore link missing label on ${t.slug}`);
        assert.match(link.href, /^https:\/\//, `learnMore href not absolute https on ${t.slug}: ${link.href}`);
      }
    }
  });

  it('states the current CRI contract, not the stale April-snapshot figures (#4968 review)', () => {
    // The first draft sourced from docs/snapshots/resilience-ranking-2026-04-21
    // (a dated claim artifact) and shipped 19 dimensions + a 0.4 grey-out gate.
    // The live contract (server/.../resilience/v1/_shared.ts + methodology doc)
    // is 20 active dimensions, a 0.55 low-confidence coverage gate, and a
    // pillar-combined penalized formula. Pin it so the stale figures can't
    // return unnoticed.
    const cov = GLOSSARY_TERMS.find((t) => t.slug === 'dimension-coverage');
    const cri = GLOSSARY_TERMS.find((t) => t.slug === 'country-resilience-index');
    assert.ok(cov && cri, 'CRI + dimension-coverage terms must exist');
    const covBlob = [cov.short, ...cov.body].join(' ');
    const criBlob = [cri.short, ...cri.body].join(' ');

    assert.match(covBlob, /\b20\b/, 'dimension-coverage must state 20 active dimensions');
    assert.match(covBlob, /0\.55/, 'dimension-coverage must state the 0.55 low-confidence gate');
    assert.doesNotMatch(covBlob, /\b19 per-dimension/, 'stale 19-dimension figure must not return');
    assert.doesNotMatch(covBlob, /falls below 0\.4\b/, 'stale 0.4 grey-out gate must not return');

    assert.match(criBlob, /196/, 'CRI must state the 196-country rankable universe');
    assert.doesNotMatch(criBlob, /aggregate of six domains/, 'CRI must describe the pillar-combined formula, not the retired flat aggregate as live');
    assert.doesNotMatch(criBlob, /out of about 217/, 'stale "196 of 217" framing must not return');
  });

  it('claims no forecast-calibration capability that does not exist (#4930)', () => {
    // No Brier/resolution/calibration scoring exists yet; the glossary must
    // not imply WorldMonitor computes it. "prediction market" is fine.
    const forbidden = /\bbrier\b|\bcalibration score|\bresolution score|\bwe (?:compute|calculate|score) (?:brier|calibration)/i;
    for (const t of GLOSSARY_TERMS) {
      const blob = [t.short, ...t.body].join(' ');
      assert.ok(!forbidden.test(blob), `${t.slug} implies a forecast-calibration capability that does not exist yet`);
    }
  });
});
