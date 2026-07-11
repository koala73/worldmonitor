import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findViteSecretEnvVars,
  runViteEnvSecretGuard,
} from '../scripts/check-vite-env-secrets.mjs';

const makeTempRepo = () => mkdtempSync(join(tmpdir(), 'wm-vite-env-guard-'));

describe('VITE secret environment guard (#5213)', () => {
  it('identifies secret-looking client-prefixed variables without flagging public browser configuration', () => {
    const found = findViteSecretEnvVars([
      'VITE_AISSTREAM_API_KEY=secret',
      'VITE_ACLED_ACCESS_TOKEN=secret',
      'VITE_VAPID_PUBLIC_KEY=public',
      'VITE_WS_API_URL=https://api.worldmonitor.app',
    ].join('\n'));
    assert.deepEqual(found, ['VITE_ACLED_ACCESS_TOKEN', 'VITE_AISSTREAM_API_KEY']);
  });

  it('fails for tracked env files and only warns for local env files', () => {
    const root = makeTempRepo();
    writeFileSync(join(root, '.env.example'), 'VITE_CLOUDFLARE_API_TOKEN=do-not-use\n');
    writeFileSync(join(root, '.env.local'), 'VITE_AISSTREAM_API_KEY=local-only\n');

    assert.throws(
      () => runViteEnvSecretGuard(root, { trackedEnvFiles: ['.env.example'], localEnvFiles: ['.env.local'] }),
      /VITE_CLOUDFLARE_API_TOKEN/,
    );

    writeFileSync(join(root, '.env.example'), 'VITE_WS_API_URL=https://api.worldmonitor.app\n');
    const warnings = [];
    assert.doesNotThrow(() => runViteEnvSecretGuard(root, {
      trackedEnvFiles: ['.env.example'],
      localEnvFiles: ['.env.local'],
      warn: message => warnings.push(message),
    }));
    assert.match(warnings.join('\n'), /VITE_AISSTREAM_API_KEY/);

    assert.throws(
      () => runViteEnvSecretGuard(root, {
        trackedEnvFiles: ['.env.example'],
        localEnvFiles: ['.env.local'],
        failOnLocal: true,
      }),
      /VITE_AISSTREAM_API_KEY/,
    );
  });

  it('checks the repository tracked env files in CI without failing on ignored local files', () => {
    assert.doesNotThrow(() => runViteEnvSecretGuard(process.cwd(), { warn: () => {} }));
  });
});
