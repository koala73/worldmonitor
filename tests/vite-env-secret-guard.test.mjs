import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('fails for mode-specific local files and inherited mixed-case VITE secrets', () => {
    const root = makeTempRepo();
    writeFileSync(join(root, '.env.production.local'), 'VITE_serviceToken=do-not-use\n');

    assert.throws(
      () => runViteEnvSecretGuard(root, {
        trackedEnvFiles: [],
        env: { VITE_apiKey: 'do-not-use' },
        failOnLocal: true,
      }),
      /VITE_(?:apiKey|serviceToken)/,
    );
  });

  it('runs the strict guard before every Vite or Tauri production build entrypoint', () => {
    const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
    const guardedCommands = Object.entries(scripts)
      .filter(([, command]) => /(?:vite|tauri) build/.test(command));

    assert.ok(guardedCommands.length > 0, 'expected production build commands');
    for (const [name, command] of guardedCommands) {
      assert.match(
        command,
        /^npm run security:vite-env-secrets -- --strict-local &&/,
        `${name} must run the strict VITE secret guard before building`,
      );
    }
  });

  it('checks the repository tracked env files in CI without failing on ignored local files', () => {
    assert.doesNotThrow(() => runViteEnvSecretGuard(process.cwd(), { warn: () => {} }));
  });
});
