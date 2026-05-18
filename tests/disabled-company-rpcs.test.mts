/**
 * Regression test — listCompanySignals + getCompanyEnrichment are intentionally
 * disabled. Both routes were built on slug-guess + keyword-match heuristics that
 * produced fabricated company intelligence (issues #3754, #3755). Handlers now
 * return empty envelopes. This test asserts they STAY empty: a future PR that
 * re-introduces an upstream fetch without a verified attribution model would
 * recreate the bug class.
 *
 * Two layers:
 *   1. Behavioral — call handlers, assert zero signals / zero sources.
 *   2. Source-level — string-scan handler files to forbid api.github.com,
 *      hn.algolia.com, sec.gov, and the slugFromDomain heuristic. Catches
 *      regressions that pass behavioral tests by short-circuiting on test
 *      inputs but call upstreams in production.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listCompanySignals } from '../server/worldmonitor/intelligence/v1/list-company-signals';
import { getCompanyEnrichment } from '../server/worldmonitor/intelligence/v1/get-company-enrichment';
import { ValidationError } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const signalsSrc = readFileSync(
  resolve(root, 'server/worldmonitor/intelligence/v1/list-company-signals.ts'),
  'utf-8',
);
const enrichmentSrc = readFileSync(
  resolve(root, 'server/worldmonitor/intelligence/v1/get-company-enrichment.ts'),
  'utf-8',
);

// Minimal ctx satisfying ServerContext — handlers ignore it.
const ctx = {} as Parameters<typeof listCompanySignals>[0];

// ────────────────────────────────────────────────────────────────────────────
// Behavioral — both handlers must return empty envelopes for any input.
// ────────────────────────────────────────────────────────────────────────────

describe('listCompanySignals — disabled', () => {
  it('returns an empty signals envelope for a plain company name', async () => {
    const res = await listCompanySignals(ctx, { company: 'Stripe', domain: '' });
    assert.deepEqual(res.signals, []);
    assert.equal(res.summary?.totalSignals, 0);
    assert.equal(res.summary?.signalDiversity, 0);
    assert.deepEqual(res.summary?.byType, {});
    assert.equal(res.summary?.strongestSignal, undefined);
    assert.equal(res.company, 'Stripe');
    assert.equal(res.domain, '');
  });

  it('echoes a normalized domain when provided', async () => {
    const res = await listCompanySignals(ctx, { company: 'Apple', domain: 'APPLE.COM' });
    assert.equal(res.domain, 'apple.com');
    assert.deepEqual(res.signals, []);
  });

  it('returns no signals for a domain that would collide with a real GitHub org', async () => {
    // Pre-kill, slugFromDomain('apple.com') -> 'apple' -> /orgs/apple/repos would
    // have returned a third-party org's repos. The disabled handler must NOT
    // surface anything for any such collision.
    const res = await listCompanySignals(ctx, { company: 'Apple Inc.', domain: 'apple.com' });
    assert.equal(res.signals.length, 0);
    assert.equal(res.summary?.totalSignals, 0);
  });

  it('throws ValidationError when company is missing', async () => {
    await assert.rejects(
      () => listCompanySignals(ctx, { company: '', domain: 'example.com' }),
      (err: unknown) => err instanceof ValidationError,
    );
  });
});

describe('getCompanyEnrichment — disabled', () => {
  it('returns an empty enrichment envelope for a plain domain', async () => {
    const res = await getCompanyEnrichment(ctx, { domain: 'stripe.com', name: '' });
    assert.deepEqual(res.techStack, []);
    assert.deepEqual(res.hackerNewsMentions, []);
    assert.deepEqual(res.sources, []);
    assert.equal(res.github, undefined);
    assert.equal(res.secFilings, undefined);
    assert.equal(res.company?.domain, 'stripe.com');
    assert.equal(res.company?.founded, 0);
  });

  it('returns no tech-stack or HN data for a name that would have matched HN stories', async () => {
    const res = await getCompanyEnrichment(ctx, { domain: '', name: 'OpenAI' });
    assert.equal(res.techStack.length, 0);
    assert.equal(res.hackerNewsMentions.length, 0);
    assert.equal(res.sources.length, 0);
  });

  it('throws ValidationError when both domain and name are missing', async () => {
    await assert.rejects(
      () => getCompanyEnrichment(ctx, { domain: '', name: '' }),
      (err: unknown) => err instanceof ValidationError,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Source-level — forbid the upstream URLs and the slug heuristic from
// reappearing in either handler. A behavioral test alone cannot catch a
// re-introduction that early-returns on the test inputs.
// ────────────────────────────────────────────────────────────────────────────

describe('disabled handlers — source must not reintroduce heuristic upstreams', () => {
  const FORBIDDEN_SUBSTRINGS = [
    'api.github.com',
    'hn.algolia.com',
    'efts.sec.gov',
    'slugFromDomain',
    'SIGNAL_KEYWORDS',
    'hiring_surge',
    'fetchJson',
    'cachedFetchJson',
  ];

  for (const needle of FORBIDDEN_SUBSTRINGS) {
    it(`list-company-signals.ts does not contain "${needle}"`, () => {
      assert.equal(
        signalsSrc.includes(needle),
        false,
        `list-company-signals.ts contains "${needle}" — handler was disabled per issues #3754/#3755; re-enabling requires a verified attribution model, not a heuristic upstream.`,
      );
    });

    it(`get-company-enrichment.ts does not contain "${needle}"`, () => {
      assert.equal(
        enrichmentSrc.includes(needle),
        false,
        `get-company-enrichment.ts contains "${needle}" — handler was disabled per issues #3754/#3755 sibling diagnosis; re-enabling requires a verified attribution model, not a heuristic upstream.`,
      );
    });
  }
});
