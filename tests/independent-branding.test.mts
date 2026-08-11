import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('primary user-facing identity and AGPL upstream attribution are present', () => {
  const brand = read('src/config/brand.ts');
  const layout = read('src/app/panel-layout.ts');
  const app = read('src/App.ts');
  const deckMap = read('src/components/DeckGLMap.ts');
  const globeMap = read('src/components/GlobeMap.ts');

  assert.match(brand, /全球实时热点追踪·探长版/);
  assert.match(brand, /Based on World Monitor（链接到原仓库），modified and distributed under AGPL-3\.0-only\./);
  assert.match(layout, /PRIMARY_BRAND/);
  assert.match(layout, /UPSTREAM_ATTRIBUTION_TEXT/);
  assert.match(layout, /UPSTREAM_REPOSITORY_URL/);
  assert.match(app, /PRIMARY_BRAND/);
  assert.match(app, /document\.title = shellTitle/);
  assert.match(deckMap, /authorBadge\.textContent = `© \$\{PRIMARY_BRAND\}`/);
  assert.match(globeMap, /authorBadge\.textContent = `© \$\{PRIMARY_BRAND\}`/);
});

test('PokieTicker is provenance-only in Phase 1 and keeps its MIT notice', () => {
  const trace = read('third_party/PokieTicker/UPSTREAM.md');
  const notice = read('LICENSES/PokieTicker-MIT.txt');

  assert.match(trace, /c16b7e34e72c2d09bb50d7b3159fa5cd6697fd19/);
  assert.match(trace, /historical snapshot only/i);
  assert.match(notice, /^MIT License/m);
  assert.match(notice, /Copyright \(c\) 2025 PokieTicker/);
  assert.ok(existsSync(`${root}THIRD_PARTY_NOTICES.md`));
});
