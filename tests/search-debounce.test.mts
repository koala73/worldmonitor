import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `src/utils/index.ts` is a barrel that re-exports from `./proxy`, which reads
// `import.meta.env.DEV` at module load — breaks plain tsx import. Strip the
// side-effecting re-export/import lines and evaluate just the standalone code
// (debounce has no env/DOM dependency). Same pattern as format-price-nullsafe.
type DebounceFn = (<T extends (...a: unknown[]) => void>(fn: T, ms: number) =>
  ((...a: Parameters<T>) => void) & { cancel(): void });

async function loadDebounce(): Promise<DebounceFn> {
  const src = readFileSync(resolve(__dirname, '../src/utils/index.ts'), 'utf-8');
  const stripped = src
    .split('\n')
    .filter((line) => !/^\s*(export\s+(type\s+)?\{[^}]*\}\s+from|export\s+\*\s+from|import\s+(type\s+)?\{[^}]*\}\s+from)\s+['"]/.test(line))
    .join('\n');
  const { code } = transformSync(stripped, { loader: 'ts', format: 'esm' });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${import.meta.url}`;
  return (await import(dataUrl)).debounce as DebounceFn;
}

// --- Behavioral: the debounce mechanism U3 relies on (R4) ---

test('debounce coalesces rapid calls into a single trailing invocation (R4)', async () => {
  const debounce = await loadDebounce();
  let calls = 0;
  const fn = debounce(() => { calls += 1; }, 20);
  fn(); fn(); fn(); fn(); // simulate fast typing
  assert.equal(calls, 0, 'must not fire synchronously per keystroke');
  await delay(45);
  assert.equal(calls, 1, 'fires once after the window settles');
});

test('debounce.cancel() drops the pending invocation (R4)', async () => {
  const debounce = await loadDebounce();
  let calls = 0;
  const fn = debounce(() => { calls += 1; }, 20);
  fn();
  fn.cancel(); // e.g. modal closed before settle
  await delay(45);
  assert.equal(calls, 0, 'cancelled debounce never fires');
});

// --- Wiring lock: no jsdom in the suite, so assert the SearchModal source
// routes the keystroke listener through the debounced wrapper and cancels it
// on close. Guards the U3 wiring against regression. ---

const searchModalSrc = readFileSync(
  resolve(__dirname, '../src/components/SearchModal.ts'),
  'utf8',
);

test('SearchModal keystroke input is debounced, not a direct handleSearch (R4)', () => {
  assert.match(
    searchModalSrc,
    /addEventListener\('input',\s*\(\)\s*=>\s*this\.debouncedSearch\(\)\)/,
    'input listener should call the debounced wrapper',
  );
  assert.doesNotMatch(
    searchModalSrc,
    /addEventListener\('input',\s*\(\)\s*=>\s*this\.handleSearch\(\)\)/,
    'input listener should not call handleSearch directly',
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
