// Google Connected Console verifies domain ownership by fetching
// https://worldmonitor.app/.well-known/google-connected-apps and looking for
// the console-issued token inside `verification_tokens`. Google requires the
// file to answer HTTP 200 directly, with no redirect.
// Docs: https://developers.google.com/connected-apps/gpc/perform-the-steps
//
// The token comes from the console ("Verify domain ownership" > "Download
// token"). Paste the downloaded file's array entries into this file; keep
// any earlier token while a re-verification is in flight.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATH = '/.well-known/google-connected-apps';
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf-8'));

describe('Google Connected Apps domain verification file', () => {
  it('is a JSON object holding only a verification_tokens string array', () => {
    const doc = JSON.parse(readFileSync(join(ROOT, 'public', PATH), 'utf-8'));
    assert.deepEqual(Object.keys(doc), ['verification_tokens']);
    assert.ok(Array.isArray(doc.verification_tokens));
    for (const token of doc.verification_tokens) {
      assert.equal(typeof token, 'string');
      assert.match(token, /^\S+$/, 'tokens are pasted verbatim, with no whitespace');
    }
  });

  it('is served as JSON and never redirected or rewritten', () => {
    const rule = vercel.headers.find((h) => h.source === PATH);
    assert.ok(rule, `vercel.json needs a header rule for ${PATH}`);
    const contentType = rule.headers.find((h) => h.key.toLowerCase() === 'content-type');
    assert.equal(contentType?.value, 'application/json; charset=utf-8');
    for (const list of [vercel.redirects ?? [], vercel.rewrites ?? []]) {
      assert.ok(
        !list.some((r) => r.source.includes('google-connected-apps')),
        'Google rejects verification files behind a redirect',
      );
    }
  });
});
