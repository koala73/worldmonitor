import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// U3 wiring lock. The suite has no jsdom (SearchModal can't be rendered) and the
// `@/utils` barrel can't be imported under tsx (proxy.ts reads import.meta.env),
// so assert against source that the keystroke listener routes through the
// debounced wrapper and that close() cancels it. The `debounce` util's own
// behavior is pre-existing WM code, unchanged by U3.
const utilsSrc = readFileSync(resolve(__dirname, '../src/utils/index.ts'), 'utf8');
const searchModalSrc = readFileSync(resolve(__dirname, '../src/components/SearchModal.ts'), 'utf8');
const searchManagerSrc = readFileSync(resolve(__dirname, '../src/app/search-manager.ts'), 'utf8');

test('debounce util exposes the trailing-timer + cancel contract U3 relies on (R4)', () => {
  // The exact mechanism U3 wires into: setTimeout-based trailing debounce + cancel.
  assert.match(utilsSrc, /export function debounce</, 'debounce is exported');
  assert.match(utilsSrc, /clearTimeout\(timeoutId\);\s*timeoutId = setTimeout\(\(\) => fn\(\.\.\.args\), delay\)/,
    'debounce coalesces via clearTimeout + setTimeout(delay)');
  assert.match(utilsSrc, /debounced\.cancel = \(\) => \{ clearTimeout\(timeoutId\); \}/,
    'debounce exposes cancel()');
});

test('SearchModal keystroke input is debounced, not a direct handleSearch (R4)', () => {
  assert.match(
    searchModalSrc,
    /addEventListener\('input',\s*\(\)\s*=>\s*\{\s*this\.onHumanInteraction\?\.\(\);\s*this\.debouncedSearch\(\);\s*\}\)/,
    'input listener should claim human authority immediately, then call the debounced wrapper',
  );
  assert.doesNotMatch(
    searchModalSrc,
    /addEventListener\('input',\s*\(\)\s*=>\s*this\.handleSearch\(\)\)/,
    'input listener should not call handleSearch directly',
  );
});

test('SearchModal applyQuery seeds the open session without a keystroke debounce', () => {
  assert.match(
    searchModalSrc,
    /public applyQuery\(term: string\): void \{\s*this\.applyProgrammaticQuery\(term\);\s*\}/,
    'SearchAction / ?q= must reuse the programmatic query seam',
  );
});

test('SearchModal exposes and wires a narrow human-interaction authority seam', () => {
  assert.match(
    searchModalSrc,
    /public setOnHumanInteraction\(callback:\s*\(\)\s*=>\s*void\):\s*void\s*\{\s*this\.onHumanInteraction = callback;/,
  );
  assert.match(
    searchManagerSrc,
    /setOnHumanInteraction\(\(\) => this\.cancelPendingProgrammaticSelection\(\)\)/,
    'SearchManager must route palette interaction through controller-level cancellation',
  );
});

test('SearchModal claims human authority for keyboard and pointer navigation', () => {
  assert.match(
    searchModalSrc,
    /addEventListener\('pointerdown', notifyHumanInteraction, \{ capture: true \}\)/,
  );
  assert.match(
    searchModalSrc,
    /addEventListener\('click', notifyHumanInteraction, \{ capture: true \}\)/,
  );
  const keydown = searchModalSrc.match(/private handleKeydown\([^)]*\)\s*:\s*void\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(keydown);
  assert.match(keydown[0].slice(0, keydown[0].indexOf('switch')), /this\.onHumanInteraction\?\.\(\)/);
});

test('programmatic palette close bypasses the human-interaction callback', () => {
  const publicClose = searchModalSrc.match(/public close\([^)]*\)\s*:\s*void\s*\{[\s\S]*?\n {2}\}/);
  const programmaticClose = searchModalSrc.match(/public closeForProgrammaticSelection\([^)]*\)\s*:\s*void\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(publicClose);
  assert.ok(programmaticClose);
  assert.match(publicClose[0], /this\.onHumanInteraction\?\.\(\)/);
  assert.match(programmaticClose[0], /this\.closeInternal\('control'\)/);
  assert.doesNotMatch(programmaticClose[0], /this\.close\(/);
});

test('SearchModal builds the debounced wrapper from the shared debounce util (R4)', () => {
  assert.match(searchModalSrc, /import \{ debounce \} from '@\/utils'/);
  assert.match(
    searchModalSrc,
    /private debouncedSearch = debounce\(\(\): void => this\.handleSearch\(\), SEARCH_DEBOUNCE_MS\)/,
    'debouncedSearch wraps handleSearch via the shared util',
  );
});

test('SearchModal.close() cancels the pending debounced search (R4)', () => {
  const closeBody = searchModalSrc.slice(searchModalSrc.indexOf('public close('));
  assert.match(
    closeBody.slice(0, 400),
    /this\.debouncedSearch\.cancel\(\)/,
    'close() should cancel the debounced search',
  );
});

// Stale-results guard: with the keystroke search debounced, Arrow/Enter must
// flush the pending search first so selection acts on current results (review #4556).
test('handleKeydown flushes the pending search before Arrow/Enter (R4)', () => {
  const m = searchModalSrc.match(/private handleKeydown\([^)]*\)\s*:\s*void\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(m, 'handleKeydown exists');
  const head = m![0].slice(0, m![0].indexOf('switch'));
  assert.match(head, /ArrowDown.*ArrowUp.*Enter/s, 'guards the nav/selection keys');
  assert.match(head, /this\.flushPendingSearch\(\)/, 'flushes before the switch');
});

test('flushPendingSearch runs handleSearch only when input changed since last search (R4)', () => {
  const m = searchModalSrc.match(/private flushPendingSearch\([^)]*\)\s*:\s*void\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(m, 'flushPendingSearch exists');
  const body = m![0];
  assert.match(body, /!==\s*this\.lastSearchedQuery/, 'compares current input to last searched query');
  assert.match(body, /this\.debouncedSearch\.cancel\(\)/, 'cancels the pending debounce');
  assert.match(body, /this\.handleSearch\(\)/, 'runs the search synchronously');
});

test('handleSearch records lastSearchedQuery so staleness can be detected (R4)', () => {
  assert.match(searchModalSrc, /this\.lastSearchedQuery = query/, 'handleSearch stores the searched query');
});

test('decorateResultOptions skips option stamping in the all-commands view', () => {
  assert.match(searchModalSrc, /import \{ decorateSearchResultOptions \} from '@\/components\/search-result-options'/);
  assert.match(
    searchModalSrc,
    /decorateSearchResultOptions\(this\.resultsList, this\.input, \{\s*skipOptions:\s*this\.showingAllCommands,?\s*\}\)/,
    'all-commands view must not stamp role=option on command rows',
  );
});
