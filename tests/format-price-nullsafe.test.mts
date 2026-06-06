import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `src/utils/index.ts` is a barrel that re-exports from `./proxy`, which reads
// `import.meta.env.DEV` at module load — a documented gotcha that breaks plain
// tsx/node imports (see comments in src/utils/cloud-prefs-migrations.ts and
// src/components/resilience-widget-utils.ts). The pure formatters in the barrel
// (formatPrice/formatChange/...) have no env or DOM dependency, so we strip the
// side-effecting re-export/import lines and evaluate just the standalone code.
async function loadUtils(): Promise<{ formatPrice: (p: number | null | undefined) => string }> {
  const src = readFileSync(resolve(__dirname, '../src/utils/index.ts'), 'utf-8');
  const stripped = src
    .split('\n')
    .filter((line) => !/^\s*(export\s+(type\s+)?\{[^}]*\}\s+from|export\s+\*\s+from|import\s+(type\s+)?\{[^}]*\}\s+from)\s+['"]/.test(line))
    .join('\n');
  const { code } = transformSync(stripped, { loader: 'ts', format: 'esm' });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Date.now()}-${Math.random()}`;
  return import(dataUrl);
}

// Reproduces WORLDMONITOR-SH: a commodity/stock record whose `price` is
// `undefined` (the live feed omits the field rather than sending `null`)
// reached `formatPrice`, which unconditionally called `price.toLocaleString()`.
// `undefined >= 1000` is false, so the else branch ran `undefined.toLocaleString()`
// → "TypeError: Cannot read properties of undefined (reading 'toLocaleString')".
// MarketPanel's `validData` filter only excluded `null` (`d.price !== null`),
// so `undefined` slipped through to `formatPrice(c.price!)`.
describe('formatPrice null-safety (WORLDMONITOR-SH)', () => {
  it('does not throw on undefined and returns the unavailable placeholder', async () => {
    const { formatPrice } = await loadUtils();
    assert.doesNotThrow(() => formatPrice(undefined));
    assert.equal(formatPrice(undefined), '--');
  });

  it('does not throw on null and returns the unavailable placeholder', async () => {
    const { formatPrice } = await loadUtils();
    assert.doesNotThrow(() => formatPrice(null));
    assert.equal(formatPrice(null), '--');
  });

  it('returns the unavailable placeholder for NaN / non-finite input', async () => {
    const { formatPrice } = await loadUtils();
    assert.equal(formatPrice(NaN), '--');
    assert.equal(formatPrice(Infinity), '--');
  });

  it('preserves existing formatting for valid prices', async () => {
    const { formatPrice } = await loadUtils();
    assert.equal(formatPrice(1500), '$1,500');
    assert.equal(formatPrice(12.5), '$12.50');
    assert.equal(formatPrice(0), '$0.00');
  });
});
