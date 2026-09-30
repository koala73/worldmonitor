/**
 * Live checks that both OpenRouter free-chain models are still usable for free.
 *
 * Run with LIVE_OPENROUTER_FREE_MODELS_TESTS=1. The default test suite runs only
 * the fixture cases, so OpenRouter availability does not affect deterministic
 * CI. Set OPENROUTER_API_KEY as well to add a real-completion check.
 *
 * A model OpenRouter stops serving for free drops out of the public /models
 * listing while its `:free` slug starts answering HTTP 404 "This model is
 * unavailable for free". That happened to `openai/gpt-oss-20b:free` (found
 * 2026-08-28) and `minimax/minimax-m3:free` (found 2026-09-24, #8570), and each
 * time the backup leg was dead for an unknown span because nothing looked.
 *
 * The keyless checks read the listing and each model's /endpoints: the model
 * must be listed at zero price, not expire within EXPIRY_WARNING_DAYS, and keep
 * a zero-price endpoint whose provider OPENROUTER_PROVIDER_ROUTING does not
 * ignore. A listed model can still refuse calls (inkling:free answered 403
 * while listed) or accept a request and return empty assistant content, which
 * only the keyed completion check can see.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  OPENROUTER_FREE_BACKUP_MODEL,
  OPENROUTER_FREE_PRIMARY_MODEL,
  OPENROUTER_PROVIDER_ROUTING,
} = require('../scripts/lib/llm-model-policy.cjs');

const LIVE = process.env.LIVE_OPENROUTER_FREE_MODELS_TESTS === '1';
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const FREE_CHAIN = [OPENROUTER_FREE_PRIMARY_MODEL, OPENROUTER_FREE_BACKUP_MODEL];
const EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;
const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'worldmonitor-free-model-probe' };

/** Problems with one /models listing entry, or [] when it is usable. */
function listingProblems(model, entry, now) {
  if (!entry) {
    return [`${model} is delisted from OpenRouter, so every call returns HTTP 404`];
  }
  const problems = [];
  const { pricing, expiration_date: expiration } = entry;
  if (Number(pricing?.prompt) !== 0 || Number(pricing?.completion) !== 0) {
    problems.push(`${model} is no longer free (prompt ${pricing?.prompt}, completion ${pricing?.completion})`);
  }
  if (expiration) {
    const expiresAt = Date.parse(expiration);
    if (!Number.isFinite(expiresAt) || expiresAt - now < EXPIRY_WARNING_DAYS * DAY_MS) {
      problems.push(`${model} expires on ${expiration}, within ${EXPIRY_WARNING_DAYS} days`);
    }
  }
  return problems;
}

/** Endpoints production can reach: zero price, not down, provider not ignored. */
function usableEndpoints(endpoints, ignoredProviders) {
  return (endpoints || []).filter((endpoint) => {
    const providerSlug = String(endpoint.tag || '').split('/')[0];
    return Number(endpoint.pricing?.prompt) === 0
      && Number(endpoint.pricing?.completion) === 0
      && Number(endpoint.status ?? 0) >= 0
      && !ignoredProviders.includes(providerSlug);
  });
}

/**
 * A completion status that says the model is gone or refused for this account
 * fails. 429 and 5xx are transient upstream load, which the chain already
 * walks past, so they pass.
 */
function completionRefused(status) {
  return !(status >= 200 && status < 300) && status !== 429 && status < 500;
}

/**
 * Production `callLlm` treats empty `choices` / blank message content as a
 * failed attempt (`reason: 'empty'`). A 200 with no usable assistant text must
 * fail the probe the same way — listing checks alone cannot see that shape.
 */
function completionContentUsable(body) {
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim().length > 0;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  assert.equal(response.ok, true, `${url} returned HTTP ${response.status}`);
  return response.json();
}

const REPLACE_HINT = 'Pick a live replacement in scripts/lib/llm-model-policy.cjs and verify it with a real completion.';

describe('OpenRouter free chain policy', () => {
  it('keeps the primary and backup in different model families', () => {
    const vendor = (model) => model.split('/')[0];
    assert.notEqual(
      vendor(OPENROUTER_FREE_PRIMARY_MODEL),
      vendor(OPENROUTER_FREE_BACKUP_MODEL),
      'one vendor quota exhaustion must not take out both free legs',
    );
    for (const model of FREE_CHAIN) assert.match(model, /:free$/);
  });

  it('flags a delisted, priced, or soon-expiring listing entry', () => {
    const now = Date.parse('2026-09-24T00:00:00Z');
    const free = { pricing: { prompt: '0', completion: '0' }, expiration_date: null };
    assert.deepEqual(listingProblems('a/b:free', free, now), []);
    assert.match(listingProblems('a/b:free', undefined, now)[0], /delisted/);
    assert.match(listingProblems('a/b:free', { ...free, pricing: { prompt: '0.1', completion: '0' } }, now)[0], /no longer free/);
    assert.match(listingProblems('a/b:free', { ...free, pricing: undefined }, now)[0], /no longer free/);
    assert.match(listingProblems('a/b:free', { ...free, expiration_date: '2026-09-25' }, now)[0], /expires on 2026-09-25/);
    assert.match(listingProblems('a/b:free', { ...free, expiration_date: 'soon' }, now)[0], /expires on soon/);
    assert.deepEqual(listingProblems('a/b:free', { ...free, expiration_date: '2026-12-31' }, now), []);
  });

  it('counts only zero-price, healthy endpoints from providers production does not ignore', () => {
    const endpoint = { tag: 'nvidia', status: 0, pricing: { prompt: '0', completion: '0' } };
    const ignored = ['novita', 'deepseek'];
    assert.equal(usableEndpoints([endpoint], ignored).length, 1);
    assert.equal(usableEndpoints([{ ...endpoint, tag: 'novita/fp8' }], ignored).length, 0);
    assert.equal(usableEndpoints([{ ...endpoint, status: -2 }], ignored).length, 0);
    assert.equal(usableEndpoints([{ ...endpoint, pricing: { prompt: '0.2', completion: '0' } }], ignored).length, 0);
    assert.equal(usableEndpoints(undefined, ignored).length, 0);
  });

  it('fails a completion only when the model is gone or refused', () => {
    for (const status of [200, 429, 500, 503]) assert.equal(completionRefused(status), false, `HTTP ${status}`);
    for (const status of [400, 401, 402, 403, 404]) assert.equal(completionRefused(status), true, `HTTP ${status}`);
  });

  it('requires non-empty assistant content from a successful completion', () => {
    assert.equal(completionContentUsable({ choices: [{ message: { content: 'ok' } }] }), true);
    assert.equal(completionContentUsable({ choices: [{ message: { content: '  ok  ' } }] }), true);
    assert.equal(completionContentUsable({ choices: [{ message: { content: '   ' } }] }), false);
    assert.equal(completionContentUsable({ choices: [{ message: { content: '' } }] }), false);
    assert.equal(completionContentUsable({ choices: [{ message: {} }] }), false);
    assert.equal(completionContentUsable({ choices: [] }), false);
    assert.equal(completionContentUsable({}), false);
    assert.equal(completionContentUsable(null), false);
  });
});

describe(`OpenRouter free models live listing (${LIVE ? 'ENABLED' : 'SKIPPED - set LIVE_OPENROUTER_FREE_MODELS_TESTS=1'})`, { skip: !LIVE }, () => {
  it('lists every free-chain model at zero price with no expiry inside 14 days', { timeout: 60_000 }, async () => {
    const { data } = await fetchJson(`${OPENROUTER_API}/models`, { headers: HEADERS });
    assert.ok(Array.isArray(data) && data.length > 0, 'OpenRouter /models returned no models');
    const byId = new Map(data.map((entry) => [entry.id, entry]));
    const problems = FREE_CHAIN.flatMap((model) => listingProblems(model, byId.get(model), Date.now()));
    assert.deepEqual(problems, [], `${problems.join('; ')}. ${REPLACE_HINT}`);
  });

  it('keeps a usable free endpoint for every free-chain model', { timeout: 60_000 }, async () => {
    const problems = [];
    for (const model of FREE_CHAIN) {
      const { data } = await fetchJson(`${OPENROUTER_API}/models/${model}/endpoints`, { headers: HEADERS });
      if (usableEndpoints(data?.endpoints, OPENROUTER_PROVIDER_ROUTING.ignore).length === 0) {
        problems.push(`${model} has no zero-price, healthy endpoint outside OPENROUTER_PROVIDER_ROUTING.ignore`);
      }
    }
    assert.deepEqual(problems, [], `${problems.join('; ')}. ${REPLACE_HINT}`);
  });
});

describe(`OpenRouter free models live completion (${LIVE && API_KEY ? 'ENABLED' : 'SKIPPED - needs OPENROUTER_API_KEY'})`, { skip: !(LIVE && API_KEY) }, () => {
  it('answers a real completion from every free-chain model', { timeout: 90_000 }, async () => {
    const problems = [];
    for (const model of FREE_CHAIN) {
      const response = await fetch(`${OPENROUTER_API}/chat/completions`, {
        method: 'POST',
        headers: {
          ...HEADERS,
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://worldmonitor.app',
          'X-Title': 'World Monitor',
        },
        // Production's request shape, so a routing or data-policy refusal
        // shows up here the way it would in the seeders.
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with the word ok.' }],
          max_tokens: 1,
          reasoning: { enabled: false },
          provider: OPENROUTER_PROVIDER_ROUTING,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (completionRefused(response.status)) {
        // Only the message: the error body also carries the account's user_id,
        // which must not land in public Actions logs.
        const body = await response.json().catch(() => ({}));
        problems.push(`${model} refused a completion with HTTP ${response.status}: ${String(body?.error?.message || '').slice(0, 200)}`);
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        const body = await response.json().catch(() => ({}));
        if (!completionContentUsable(body)) {
          problems.push(`${model} returned HTTP ${response.status} with empty assistant content`);
        }
      }
    }
    assert.deepEqual(problems, [], `${problems.join('; ')}. ${REPLACE_HINT}`);
  });
});
