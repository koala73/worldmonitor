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
  assert.match(source, /if \(ORBITAL_WATCH_ENABLED\) \{\s*this\.orbitalRouteUnsubscribe = watchOrbitalRoute\([^;]*\);\s*window\.addEventListener\(ORBITAL_EVIDENCE_EVENT, this\.openOrbitalEvidence\);\s*\}/);
  assert.equal(source.match(/addEventListener\(ORBITAL_EVIDENCE_EVENT/g)?.length, 1);
  assert.equal(source.match(/watchOrbitalRoute\(/g)?.length, 1);
  assert.equal(source.match(/contextMenu\.satellitePasses/g)?.length, 1);
});

test('the map-popup imagery row renders only behind the flag', () => {
  assert.match(read('src/components/map-popup-imagery.ts'), /export function hasImageryRow\(type: string, data: unknown, enabled = ORBITAL_WATCH_ENABLED\)/);
  const popup = read('src/components/MapPopup.ts');
  assert.match(popup, /const imageryRow = hasImageryRow\(data\.type, data\.data\);/);
  assert.match(popup, /if \(imageryRow\) this\.mountImagery\(data\);/);
  assert.equal(popup.match(/mountImagery\(data\)/g)?.length, 1);
});

test('the docs navigation and data-source list do not advertise Orbital Watch while dark', () => {
  assert.doesNotMatch(read('docs/docs.json'), /"(?:zh\/)?orbital-watch"/);
  assert.doesNotMatch(read('docs/data-sources.mdx'), /\*\*Orbital Watch\*\*/);
});

test('the command palette entry and a shared #orbital link open the lookup only behind the flag', () => {
  const commands = read('src/config/commands.ts');
  assert.match(commands, /const ORBITAL_COMMANDS: Command\[\] = ORBITAL_WATCH_ENABLED\s*\? \[\{ id: 'orbital:search'/);
  assert.equal(commands.match(/'orbital:search'/g)?.length, 1);
  assert.match(read('src/App.ts'), /this\.pendingOrbitalShareLink = ORBITAL_WATCH_ENABLED \? takeOrbitalShareLink\(\) : null;/);
});
