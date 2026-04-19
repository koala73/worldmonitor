// Parity tests for the scripts-side HMAC signer.
//
// The signing algorithm lives in TWO places: server/_shared/brief-
// url.ts (used by edge routes for verify, and by any TS code that
// wants to mint URLs) and scripts/lib/brief-url-sign.mjs (used by
// the consolidated digest cron to mint magazine URLs to embed in
// notification bodies).
//
// Any drift between them silently produces tokens the edge route
// cannot verify. These tests prove: (a) the same (userId, date,
// secret) input produces byte-identical tokens across both modules,
// (b) tokens signed by the scripts side pass the edge-side
// verifyBriefToken.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BriefUrlError,
  signBriefToken as signTokenScripts,
  signBriefUrl as signUrlScripts,
} from '../scripts/lib/brief-url-sign.mjs';
import {
  signBriefToken as signTokenEdge,
  verifyBriefToken,
} from '../server/_shared/brief-url.ts';

const SECRET = 'consolidation-parity-secret-0xdead';
const USER_ID = 'user_consolidated123';
// Slot format: YYYY-MM-DD-HHMM (per compose run, user's tz).
const ISSUE_DATE = '2026-04-18-0800';

describe('scripts/lib/brief-url-sign parity with server/_shared/brief-url', () => {
  it('produces byte-identical tokens for the same inputs', async () => {
    const a = await signTokenScripts(USER_ID, ISSUE_DATE, SECRET);
    const b = await signTokenEdge(USER_ID, ISSUE_DATE, SECRET);
    assert.equal(a, b, 'scripts + edge signers must agree byte-for-byte');
  });

  it('scripts-signed tokens pass edge-side verifyBriefToken', async () => {
    const token = await signTokenScripts(USER_ID, ISSUE_DATE, SECRET);
    assert.equal(
      await verifyBriefToken(USER_ID, ISSUE_DATE, token, SECRET),
      true,
    );
  });

  it('signBriefUrl composes a working URL', async () => {
    const url = await signUrlScripts({
      userId: USER_ID,
      issueDate: ISSUE_DATE,
      baseUrl: 'https://worldmonitor.app',
      secret: SECRET,
    });
    assert.match(
      url,
      new RegExp(`^https://worldmonitor\\.app/api/brief/${USER_ID}/${ISSUE_DATE}\\?t=[A-Za-z0-9_-]{43}$`),
    );
  });

  it('rejects malformed userId at sign time', async () => {
    await assert.rejects(
      () => signTokenScripts('user with spaces', ISSUE_DATE, SECRET),
      (err) => err instanceof BriefUrlError && err.code === 'invalid_user_id',
    );
  });

  it('rejects empty secret at sign time', async () => {
    await assert.rejects(
      () => signTokenScripts(USER_ID, ISSUE_DATE, ''),
      (err) => err instanceof BriefUrlError && err.code === 'missing_secret',
    );
  });
});
