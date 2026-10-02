import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  EMBED_GRANT_TTL_MS,
  isEmbedGrantShape,
  mintEmbedGrant,
  verifyEmbedGrant,
} from '../server/_shared/embed-grant';
import { issueSessionToken, validateSessionToken } from '../api/_session.js';

const SECRET = 'embed-grant-test-secret-that-is-long-enough';
let previousSecret: string | undefined;

before(() => {
  previousSecret = process.env.WM_SESSION_SECRET;
  process.env.WM_SESSION_SECRET = SECRET;
});

after(() => {
  if (previousSecret === undefined) delete process.env.WM_SESSION_SECRET;
  else process.env.WM_SESSION_SECRET = previousSecret;
});

/**
 * Mint a grant the way the module does, so a test can put a payload the module
 * would never issue behind a signature it cannot distinguish from its own.
 * The signing domain is duplicated here on purpose — it is what these tests
 * pin, so reading it from the module under test would prove nothing.
 */
function signGrantForTest(payload: { p: string; a: string; iat: number; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(`wmg.v1.${body}`).digest('base64url');
  return `wmg_${body}.${sig}`;
}

describe('embed grant', () => {
  it('round-trips panel and account claims with a 30-minute window', async () => {
    const now = 1_700_000_000_000;
    const { token, expiresAt } = await mintEmbedGrant({ panel: 'map', accountId: 'user_abc' }, now);

    assert.ok(token.startsWith('wmg_'));
    assert.equal(isEmbedGrantShape(token), true);
    assert.equal(expiresAt, now + EMBED_GRANT_TTL_MS);
    assert.equal(EMBED_GRANT_TTL_MS, 30 * 60 * 1000);

    const claims = await verifyEmbedGrant(token, now + 1_000);
    assert.deepEqual(claims, {
      panel: 'map',
      accountId: 'user_abc',
      issuedAt: now,
      expiresAt: now + EMBED_GRANT_TTL_MS,
    });
  });

  it('expires exactly at exp', async () => {
    const now = 1_700_000_000_000;
    const { token } = await mintEmbedGrant({ panel: 'map', accountId: 'user_abc' }, now);

    assert.ok(await verifyEmbedGrant(token, now + EMBED_GRANT_TTL_MS - 1));
    assert.equal(await verifyEmbedGrant(token, now + EMBED_GRANT_TTL_MS), null);
    assert.equal(await verifyEmbedGrant(token, now + EMBED_GRANT_TTL_MS + 60_000), null);
  });

  it('carries the panel so a grant cannot be replayed onto another panel', async () => {
    const { token } = await mintEmbedGrant({ panel: 'fear-greed', accountId: 'user_abc' });
    const claims = await verifyEmbedGrant(token);
    assert.equal(claims?.panel, 'fear-greed');
  });

  it('rejects a tampered payload, a tampered signature, and a truncated token', async () => {
    const { token } = await mintEmbedGrant({ panel: 'map', accountId: 'user_abc' });
    const [body, sig] = token.slice('wmg_'.length).split('.') as [string, string];

    const forged = Buffer.from(JSON.stringify({
      p: 'map',
      a: 'user_attacker',
      iat: Date.now(),
      exp: Date.now() + EMBED_GRANT_TTL_MS,
    })).toString('base64url');
    assert.equal(await verifyEmbedGrant(`wmg_${forged}.${sig}`), null);

    const flipped = `${sig.slice(0, -1)}${sig.at(-1) === 'A' ? 'B' : 'A'}`;
    assert.equal(await verifyEmbedGrant(`wmg_${body}.${flipped}`), null);

    assert.equal(await verifyEmbedGrant(`wmg_${body}`), null);
    assert.equal(await verifyEmbedGrant(`wmg_${body}.`), null);
    assert.equal(await verifyEmbedGrant(`wmg_.${sig}`), null);
    assert.equal(await verifyEmbedGrant(''), null);
    assert.equal(await verifyEmbedGrant(null), null);
  });

  it('rejects a non-canonical base64url signature that decodes to the same bytes', async () => {
    const { token } = await mintEmbedGrant({ panel: 'map', accountId: 'user_abc' });
    const [body, sig] = token.slice('wmg_'.length).split('.') as [string, string];

    // The final base64 character of a 32-byte digest carries unused padding
    // bits. Flipping them yields a different string that decodes to identical
    // bytes — it must still be refused.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = sig.at(-1) as string;
    const decoded = Buffer.from(sig, 'base64url');
    let nonCanonical: string | null = null;
    for (const ch of alphabet) {
      if (ch === last) continue;
      const candidate = `${sig.slice(0, -1)}${ch}`;
      if (Buffer.from(candidate, 'base64url').equals(decoded)) {
        nonCanonical = candidate;
        break;
      }
    }
    assert.ok(nonCanonical, 'expected an alternate encoding of the same digest bytes');
    assert.notEqual(nonCanonical, sig);
    assert.equal(await verifyEmbedGrant(`wmg_${body}.${nonCanonical}`), null);
  });

  it('rejects an unknown panel id even when the signature is ours', async () => {
    // Signed by us, so this is not a forgery — it is a payload naming a panel
    // the allowlist does not contain, which must not authenticate.
    const { token } = await mintEmbedGrant(
      { panel: 'x-feed' as unknown as 'map', accountId: 'user_abc' },
    );
    assert.equal(await verifyEmbedGrant(token), null);
  });

  it('rejects a correctly signed grant whose window exceeds the issued TTL', async () => {
    const now = 1_700_000_000_000;
    // Signed with the real secret over the real signing domain, so the
    // signature verifies — only the claimed lifetime is out of policy.
    const stretched = signGrantForTest({ p: 'map', a: 'user_abc', iat: now, exp: now + EMBED_GRANT_TTL_MS + 1 });
    assert.equal(await verifyEmbedGrant(stretched, now), null);

    const atLimit = signGrantForTest({ p: 'map', a: 'user_abc', iat: now, exp: now + EMBED_GRANT_TTL_MS });
    assert.ok(await verifyEmbedGrant(atLimit, now), 'a grant at exactly the TTL must still verify');
  });

  it('rejects a correctly signed grant with an empty account id', async () => {
    const now = 1_700_000_000_000;
    const empty = signGrantForTest({ p: 'map', a: '', iat: now, exp: now + EMBED_GRANT_TTL_MS });
    assert.equal(await verifyEmbedGrant(empty, now), null);
  });

  it('is domain-separated from the wms_ browser session under the same secret', async () => {
    const grant = await mintEmbedGrant({ panel: 'map', accountId: 'user_abc' });
    const session = await issueSessionToken();

    // A session token relabelled as a grant must not verify, and vice versa —
    // both are HMACs under WM_SESSION_SECRET, so only the signing-domain
    // prefix separates them.
    const sessionAsGrant = `wmg_${session.token.slice('wms_'.length)}`;
    assert.equal(await verifyEmbedGrant(sessionAsGrant), null);

    const grantAsSession = `wms_${grant.token.slice('wmg_'.length)}`;
    assert.equal(await validateSessionToken(grantAsSession), false);

    // Sanity: each is valid on its own surface.
    assert.ok(await verifyEmbedGrant(grant.token));
    assert.equal(await validateSessionToken(session.token), true);
  });

  it('refuses to verify when the signing secret is missing or too short', async () => {
    const { token } = await mintEmbedGrant({ panel: 'map', accountId: 'user_abc' });

    process.env.WM_SESSION_SECRET = 'too-short';
    assert.equal(await verifyEmbedGrant(token), null);

    delete process.env.WM_SESSION_SECRET;
    assert.equal(await verifyEmbedGrant(token), null);
    await assert.rejects(() => mintEmbedGrant({ panel: 'map', accountId: 'user_abc' }));

    process.env.WM_SESSION_SECRET = SECRET;
  });
});
