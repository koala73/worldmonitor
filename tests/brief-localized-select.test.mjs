// Localized sibling envelope (brief l10n epic #10877, PR 1): readers
// prefer brief:l10n:{userId}:{slot} only when it matches the canonical
// English envelope, and never fail because of it.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { selectBriefEnvelope } from '../server/_shared/brief-render.js';
import { briefLocalizedKey } from '../shared/brief-envelope.js';

const USER = 'user_l10n';
const SLOT = '2026-04-17-0800';
const SECRET = 'l10n-select-test-secret';

function story(i, overrides = {}) {
  return {
    category: 'Energy',
    country: 'IR',
    threatLevel: 'high',
    headline: `Headline ${i}`,
    description: `Description ${i}`,
    source: 'Multiple wires',
    sourceUrl: `https://example.com/story-${i}`,
    clusterId: `cluster-${i}`,
    whyMatters: `Why story ${i} matters.`,
    ...overrides,
  };
}

function canonical() {
  const stories = [story(1), story(2)];
  return {
    version: 4,
    issuedAt: 1_700_000_000_000,
    data: {
      user: { name: 'Elie', tz: 'UTC' },
      issue: '17.04',
      date: '2026-04-17',
      dateLong: '17 April 2026',
      digest: {
        greeting: 'Good evening.',
        lead: 'English lead.',
        numbers: { clusters: 10, multiSource: 2, surfaced: stories.length },
        threads: [{ tag: 'Energy', teaser: 'English teaser.' }],
        signals: ['English signal.'],
      },
      stories,
    },
  };
}

function localized(overrides = {}) {
  const base = canonical();
  return {
    ...base,
    version: 5,
    lang: 'fr',
    data: {
      ...base.data,
      dateLong: '17 avril 2026',
      digest: { ...base.data.digest, greeting: 'Bonsoir.', lead: 'Résumé en français.' },
      stories: base.data.stories.map((s) => ({ ...s, headline: `Titre ${s.clusterId}` })),
    },
    ...overrides,
  };
}

describe('selectBriefEnvelope', () => {
  it('selectBriefEnvelope returns canonical when the sibling is null', () => {
    const can = canonical();
    assert.equal(selectBriefEnvelope(can, null), can);
    assert.equal(selectBriefEnvelope(can, undefined), can);
  });

  it('selectBriefEnvelope returns the sibling when issuedAt and clusterId order match', () => {
    const loc = localized();
    assert.equal(selectBriefEnvelope(canonical(), loc), loc);
  });

  it('selectBriefEnvelope returns canonical when issuedAt differs', () => {
    const can = canonical();
    assert.equal(selectBriefEnvelope(can, localized({ issuedAt: can.issuedAt - 1 })), can);
  });

  it('selectBriefEnvelope returns canonical when the clusterId sequence differs', () => {
    const can = canonical();
    const loc = localized();
    loc.data.stories.reverse();
    assert.equal(selectBriefEnvelope(can, loc), can);
    const shorter = localized();
    shorter.data.stories = shorter.data.stories.slice(0, 1);
    shorter.data.digest.numbers = { ...shorter.data.digest.numbers, surfaced: 1 };
    assert.equal(selectBriefEnvelope(can, shorter), can);
  });

  it('selectBriefEnvelope returns canonical when the sibling fails assertBriefEnvelope', () => {
    const can = canonical();
    assert.equal(selectBriefEnvelope(can, localized({ lang: 'en' })), can);
    assert.equal(selectBriefEnvelope(can, localized({ lang: 'en-US' })), can);
    assert.equal(selectBriefEnvelope(can, localized({ lang: 'en-GB' })), can);
    assert.equal(selectBriefEnvelope(can, localized({ extra: 1 })), can);
    assert.equal(selectBriefEnvelope(can, 'not an envelope'), can);
    // A valid v4 envelope in the sibling slot is not a localized copy.
    assert.equal(selectBriefEnvelope(can, canonical()), can);
  });

  it('briefLocalizedKey builds brief:l10n:{userId}:{slot}', () => {
    assert.equal(briefLocalizedKey('user_a', '2026-04-17-0800'), 'brief:l10n:user_a:2026-04-17-0800');
  });
});

// ── Route behaviour with a per-key Upstash stub ──────────────────────────────

const saved = {
  secret: process.env.BRIEF_URL_SIGNING_SECRET,
  share: process.env.BRIEF_SHARE_SECRET,
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of [
    ['BRIEF_URL_SIGNING_SECRET', saved.secret],
    ['BRIEF_SHARE_SECRET', saved.share],
    ['UPSTASH_REDIS_REST_URL', saved.url],
    ['UPSTASH_REDIS_REST_TOKEN', saved.token],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * @param {Record<string, unknown | Error>} store key -> value (Error = HTTP 500)
 * @returns {string[]} keys requested
 */
function stubUpstash(store) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  delete process.env.BRIEF_SHARE_SECRET;
  const requested = [];
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = url.match(/^https:\/\/fake-upstash\.invalid\/get\/(.+)$/);
    if (!m) return new Response('not stubbed', { status: 404 });
    const key = decodeURIComponent(m[1]);
    requested.push(key);
    const value = store[key];
    if (value instanceof Error) return new Response('boom', { status: 500 });
    return Response.json({ result: value === undefined ? null : JSON.stringify(value) });
  };
  return requested;
}

async function magazine() {
  process.env.BRIEF_URL_SIGNING_SECRET = SECRET;
  const { default: handler } = await import('../api/brief/[userId]/[issueDate].ts');
  const { signBriefToken } = await import('../server/_shared/brief-url.ts');
  const token = await signBriefToken(USER, SLOT, SECRET);
  return handler(new Request(`https://worldmonitor.app/api/brief/${USER}/${SLOT}?t=${token}`, {
    headers: { origin: 'https://worldmonitor.app' },
  }));
}

describe('brief readers and the localized sibling', () => {
  it('magazine route renders the sibling when present and valid', async () => {
    stubUpstash({ [`brief:${USER}:${SLOT}`]: canonical(), [briefLocalizedKey(USER, SLOT)]: localized() });
    const res = await magazine();
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Résumé en français/);
    assert.doesNotMatch(html, /English lead/);
  });

  it('magazine route renders canonical when the sibling read throws', async () => {
    stubUpstash({ [`brief:${USER}:${SLOT}`]: canonical(), [briefLocalizedKey(USER, SLOT)]: new Error('down') });
    const res = await magazine();
    assert.equal(res.status, 200);
    assert.match(await res.text(), /English lead/);
  });

  it('magazine route 404s on a malformed canonical even with a matching sibling', async () => {
    const broken = canonical();
    delete broken.data.digest.lead;
    stubUpstash({ [`brief:${USER}:${SLOT}`]: broken, [briefLocalizedKey(USER, SLOT)]: localized() });
    const res = await magazine();
    assert.equal(res.status, 404);
  });

  it('magazine route still 404s when only the sibling exists', async () => {
    stubUpstash({ [briefLocalizedKey(USER, SLOT)]: localized() });
    const res = await magazine();
    assert.equal(res.status, 404);
  });

  it('public route never requests a brief:l10n: key', async () => {
    process.env.BRIEF_SHARE_SECRET = 'l10n-share-secret';
    const { buildPublicBriefUrl, BRIEF_PUBLIC_POINTER_PREFIX, encodePublicPointer } = await import('../server/_shared/brief-share-url.ts');
    const built = await buildPublicBriefUrl({ userId: USER, issueDate: SLOT, baseUrl: 'https://worldmonitor.app', secret: 'l10n-share-secret' });
    const requested = stubUpstash({
      [`${BRIEF_PUBLIC_POINTER_PREFIX}${built.hash}`]: encodePublicPointer(USER, SLOT),
      [`brief:${USER}:${SLOT}`]: canonical(),
      [briefLocalizedKey(USER, SLOT)]: localized(),
    });
    const { default: handler } = await import('../api/brief/public/[hash].ts');
    const res = await handler(new Request(`https://worldmonitor.app/api/brief/public/${built.hash}`, {
      headers: { origin: 'https://worldmonitor.app' },
    }));
    assert.equal(res.status, 200);
    assert.ok(requested.some((key) => key === `brief:${USER}:${SLOT}`), `canonical read expected; got ${requested.join(', ')}`);
    assert.equal(requested.some((key) => key.includes('brief:l10n:')), false);
    assert.doesNotMatch(await res.text(), /français|Bonsoir/);
  });
});
