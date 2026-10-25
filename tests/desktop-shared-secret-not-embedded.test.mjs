/**
 * WM_DESKTOP_SHARED_SECRET and WM_DESKTOP_AUTH_ALLOW_LEGACY must stay deleted.
 *
 * src-tauri/src/main.rs once read the shared secret with `option_env!`, so any
 * value present when a release compiled was baked into every shipped binary,
 * where `strings` recovers it. The cloud handler trusted an HMAC from that key
 * to skip Turnstile on waitlist sign-ups, so one leaked copy was a captcha
 * bypass for anyone. The whole path is gone; every caller passes Turnstile.
 * Neither name may come back. If the desktop app ever needs its own lane, it
 * gets a per-install credential, never a shared key or a legacy switch.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..');
const FORBIDDEN = ['WM_DESKTOP_SHARED_SECRET', 'WM_DESKTOP_AUTH_ALLOW_LEGACY'];
const SCANNED = ['src-tauri', 'server', 'api', '.github', 'docs', '.env.example'];
const SKIPPED_DIRS = new Set(['node_modules', 'target', 'dist', 'gen', 'solutions']);
const MAX_BYTES = 2 * 1024 * 1024;

function* walk(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (SKIPPED_DIRS.has(entry)) continue;
      yield* walk(join(path, entry));
    }
    return;
  }
  if (stat.size <= MAX_BYTES) yield path;
}

describe('desktop shared secret stays deleted', () => {
  it('neither legacy env name appears under the scanned paths', () => {
    const offenders = [];
    for (const start of SCANNED) {
      for (const file of walk(join(root, start))) {
        const text = readFileSync(file, 'utf8');
        for (const name of FORBIDDEN) {
          if (!text.includes(name)) continue;
          const line = text.slice(0, text.indexOf(name)).split('\n').length;
          offenders.push(`${relative(root, file)}:${line} ${name}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('main.rs embeds no desktop secret at compile time', () => {
    const main = readFileSync(join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
    const embedded = [...main.matchAll(/option_env!\("([A-Z0-9_]+)"\)/g)].map((match) => match[1]);
    assert.deepEqual(embedded, ['CONVEX_URL']);
  });
});
