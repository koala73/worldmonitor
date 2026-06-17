import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('embed entry boundary', () => {
  it('boots the shared map container while staying out of the authenticated app shell', () => {
    const files = [
      'src/embed-main.ts',
      'src/embed/embed-data-loader.ts',
      'src/embed/embed-url.ts',
    ];
    const source = files.map((file) => readFileSync(resolve(root, file), 'utf-8')).join('\n');
    assert.ok(
      source.includes('@/components/MapContainer'),
      'embed entry should use the shared current map container rather than booting a legacy map directly',
    );

    const forbidden = [
      '@/App',
      '@/app/panel-layout',
      '@/services/auth-state',
      '@/services/clerk',
      '@/services/cloud-preferences',
      '@/services/push-notifications',
      '@/services/runtime',
    ];
    for (const token of forbidden) {
      assert.ok(!source.includes(token), `embed entry must not import ${token}`);
    }
  });

  it('loads public conflict events without importing the full conflict service into the embed entry', () => {
    const loaderSource = readFileSync(resolve(root, 'src/embed/embed-data-loader.ts'), 'utf-8');
    const mapSource = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');
    assert.ok(loaderSource.includes('@/generated/client/worldmonitor/conflict/v1/service_client'), 'embed loader should use the generated public conflict client');
    assert.ok(loaderSource.includes('listAcledEvents'), 'conflicts layer should fetch public ACLED conflict events');
    assert.ok(loaderSource.includes('this.map.setConflictEvents'), 'conflicts layer should push fetched events into the flat map');
    assert.ok(!loaderSource.includes('@/services/conflict'), 'embed loader must not import the full conflict service because it pulls runtime app helpers');
    assert.ok(mapSource.includes('setConflictEvents'), 'flat map should expose a conflict event setter for the embed');
    assert.ok(mapSource.includes('conflict-event-marker'), 'flat map should render fetched conflict event markers');
  });

  it('keeps the shared SVG map independent of runtime/auth imports used by the app shell', () => {
    const source = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');
    assert.ok(!source.includes("@/services/runtime"), 'Map.ts must not import services/runtime because the public embed imports Map.ts');
    assert.ok(!source.includes("@/services/auth-state"), 'Map.ts must not import auth-state because the public embed imports Map.ts');
    assert.ok(!source.includes("@/services/clerk"), 'Map.ts must not import Clerk because the public embed imports Map.ts');
  });
});
