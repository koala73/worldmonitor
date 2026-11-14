import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Orbital Watch stays off unless the build sets VITE_ENABLE_ORBITAL_WATCH=true', () => {
  assert.match(read('src/config/orbital-watch-flag.ts'), /ORBITAL_WATCH_ENABLED = import\.meta\.env\.VITE_ENABLE_ORBITAL_WATCH === 'true'/);
});

test('the map context menu and the #orbital= route open the lookup only behind the flag', () => {
  const source = read('src/app/country-intel.ts');
  assert.match(source, /if \(ORBITAL_WATCH_ENABLED\) items\.push\(\{\s*label: t\('contextMenu\.satellitePasses'\)/);
  assert.match(source, /if \(ORBITAL_WATCH_ENABLED\) this\.orbitalRouteUnsubscribe = watchOrbitalRoute\(\);/);
  assert.equal(source.match(/watchOrbitalRoute\(\)/g)?.length, 1);
  assert.equal(source.match(/contextMenu\.satellitePasses/g)?.length, 1);
});

test('the command palette entry and a shared #orbital link open the lookup only behind the flag', () => {
  assert.match(read('src/config/commands.ts'), /\.\.\.\(ORBITAL_WATCH_ENABLED \? \[\{ id: 'orbital:search'/);
  assert.match(read('src/App.ts'), /this\.pendingOrbitalShareLink = ORBITAL_WATCH_ENABLED \? takeOrbitalShareLink\(\) : null;/);
});
