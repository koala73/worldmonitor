// api/latest-brief reads the localized sibling (brief l10n epic #10877,
// PR 1): the preview text and `lang` come from it only when it matches
// the canonical envelope; otherwise lang is "en".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const USER = 'user_test';
const SLOT = '2026-04-17-0800';

function canonical() {
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
        numbers: { clusters: 10, multiSource: 2, surfaced: 1 },
        threads: [{ tag: 'Energy', teaser: 'English teaser.' }],
        signals: [],
      },
      stories: [{
        category: 'Energy', country: 'IR', threatLevel: 'high', headline: 'Headline', description: 'Description',
        source: 'Wire', sourceUrl: 'https://example.com/1', clusterId: 'cluster-1', whyMatters: 'Why it matters.',
      }],
    },
  };
}

function sibling() {
  const base = canonical();
  return {
    ...base,
    version: 5,
    lang: 'fr',
    data: { ...base.data, dateLong: '17 avril 2026', digest: { ...base.data.digest, greeting: 'Bonsoir.' } },
  };
}

async function latestBrief(t: { mock: { method: Function } }, store: Record<string, unknown>) {
  const issuer = 'https://clerk.test';
  const kid = 'latest-brief-l10n-key';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid, use: 'sig' };
  const jwt = await new SignJWT({ plan: 'pro' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(issuer)
    .setSubject(USER)
    .setAudience('convex')
    .setExpirationTime('5m')
    .sign(privateKey);
  const saved = {
    CLERK_JWT_ISSUER_DOMAIN: process.env.CLERK_JWT_ISSUER_DOMAIN,
    BRIEF_URL_SIGNING_SECRET: process.env.BRIEF_URL_SIGNING_SECRET,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  process.env.CLERK_JWT_ISSUER_DOMAIN = issuer;
  process.env.BRIEF_URL_SIGNING_SECRET = 'latest-brief-l10n-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    const key = decodeURIComponent(url.split('/get/')[1] ?? '');
    const value = store[key];
    return Response.json({ result: value === undefined ? null : JSON.stringify(value) });
  });
  const { __resetJwksForTests } = await import('../server/auth-session.ts');
  __resetJwksForTests();
  try {
    const { default: handler } = await import('../api/latest-brief.ts');
    const res = await handler(new Request('https://worldmonitor.app/api/latest-brief', {
      headers: { authorization: `Bearer ${jwt}`, origin: 'https://worldmonitor.app' },
    }));
    assert.equal(res.status, 200);
    return await res.json();
  } finally {
    __resetJwksForTests();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('api/latest-brief localized sibling', () => {
  it('latest-brief returns greeting, dateLong and lang from the sibling', async (t) => {
    const body = await latestBrief(t, {
      [`brief:latest:${USER}`]: { issueSlot: SLOT },
      [`brief:${USER}:${SLOT}`]: canonical(),
      [`brief:l10n:${USER}:${SLOT}`]: sibling(),
    });
    assert.equal(body.status, 'ready');
    assert.equal(body.greeting, 'Bonsoir.');
    assert.equal(body.dateLong, '17 avril 2026');
    assert.equal(body.lang, 'fr');
  });

  it('latest-brief returns lang "en" with no sibling', async (t) => {
    const body = await latestBrief(t, {
      [`brief:latest:${USER}`]: { issueSlot: SLOT },
      [`brief:${USER}:${SLOT}`]: canonical(),
    });
    assert.equal(body.status, 'ready');
    assert.equal(body.greeting, 'Good evening.');
    assert.equal(body.lang, 'en');
  });

  it('latest-brief stays composing when only the sibling exists', async (t) => {
    const body = await latestBrief(t, {
      [`brief:latest:${USER}`]: { issueSlot: SLOT },
      [`brief:l10n:${USER}:${SLOT}`]: sibling(),
    });
    assert.equal(body.status, 'composing');
  });
});
