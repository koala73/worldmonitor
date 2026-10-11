/**
 * WM_DESKTOP_SHARED_SECRET must never reach a desktop release build.
 *
 * src-tauri/src/main.rs reads it with `option_env!`, so any value present when
 * a release is compiled is baked into every shipped binary, where `strings`
 * recovers it. The server (register-interest.ts) trusts an HMAC from that key
 * to skip Turnstile on waitlist sign-ups, so an embedded copy would let anyone
 * sign requests that bypass the captcha and send confirmation mail to
 * arbitrary addresses. Release builds leave it unset today, which keeps the
 * desktop bypass fail-closed; this pins that. Moving desktop sign-ups to a
 * real per-install credential is the way to enable the bypass, not this key.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..');
const workflowDir = join(root, '.github', 'workflows');

describe('desktop shared secret stays out of release builds', () => {
  it('no GitHub workflow passes WM_DESKTOP_SHARED_SECRET to a build', () => {
    const offenders = readdirSync(workflowDir)
      .filter((file) => /\.ya?ml$/.test(file))
      .filter((file) => readFileSync(join(workflowDir, file), 'utf8').includes('WM_DESKTOP_SHARED_SECRET'));
    assert.deepEqual(offenders, []);
  });

  it('main.rs still reads the key at compile time, so the guard above is load-bearing', () => {
    const main = readFileSync(join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
    assert.match(main, /option_env!\("WM_DESKTOP_SHARED_SECRET"\)/);
  });
});
