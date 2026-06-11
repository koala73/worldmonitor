import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('embed entry boundary', () => {
  it('keeps the public embed boot out of the authenticated app shell', () => {
    const files = [
      'src/embed-main.ts',
      'src/embed/embed-data-loader.ts',
      'src/embed/embed-url.ts',
    ];
    const source = files.map((file) => readFileSync(resolve(root, file), 'utf-8')).join('\n');
    const forbidden = [
      '@/App',
      '@/app/panel-layout',
      '@/services/auth-state',
      '@/services/clerk',
      '@/services/cloud-preferences',
      '@/services/push-notifications',
      '@/services/runtime',
      '@/utils/wm-session',
      '@/components/MapContainer',
    ];
    for (const token of forbidden) {
      assert.ok(!source.includes(token), `embed entry must not import ${token}`);
    }
  });

  it('keeps the shared SVG map independent of runtime/auth imports used by the app shell', () => {
    const source = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');
    assert.ok(!source.includes("@/services/runtime"), 'Map.ts must not import services/runtime because the public embed imports Map.ts');
    assert.ok(!source.includes("@/services/auth-state"), 'Map.ts must not import auth-state because the public embed imports Map.ts');
    assert.ok(!source.includes("@/services/clerk"), 'Map.ts must not import Clerk because the public embed imports Map.ts');
  });
});
