import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `src/utils/market-format.ts` holds the pure formatters (formatPrice /
// formatChange / getChangeClass / getHeatmapClass). The `@/utils` barrel
// re-exports them and also loads `./proxy`, which reads `import.meta.env.DEV`
// at module load — a documented gotcha that breaks plain tsx/node imports.
interface LoadedUtils {
  formatPrice: (p: number | null | undefined) => string;
  formatChange: (p: number | null | undefined) => string;
  getChangeClass: (p: number | null | undefined) => string;
  getHeatmapClass: (p: number | null | undefined) => string;
}

async function loadUtils(): Promise<LoadedUtils> {
  const src = readFileSync(resolve(__dirname, '../src/utils/market-format.ts'), 'utf-8');
  const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
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

// #9705: two fraction digits (and CryptoPanel's default locale string) round a
// positive sub-cent price to a literal zero. A shared magnitude formatter must
// keep that price distinguishable from an actual zero without a long digit run.
describe('formatPrice sub-cent magnitude (#9705)', () => {
  it('shows a sub-cent price instead of $0.00', async () => {
    const { formatPrice } = await loadUtils();
    assert.equal(formatPrice(0.00024), '$0.00024');
    assert.equal(formatPrice(-0.00024), '$-0.00024');
    assert.equal(formatPrice(0.009), '$0.009');
  });

  it('shows one hundred-millionth and an honest floor beneath it', async () => {
    const { formatPrice } = await loadUtils();
    assert.equal(formatPrice(1e-8), '$0.00000001');
    assert.equal(formatPrice(-1e-8), '$-0.00000001');
    assert.equal(formatPrice(1e-12), '<$0.00000001');
    assert.equal(formatPrice(-1e-12), '>-$0.00000001');
  });

  it('keeps ordinary, zero, negative, and non-finite prices on their existing paths', async () => {
    const { formatPrice } = await loadUtils();
    assert.equal(formatPrice(0), '$0.00');
    assert.equal(formatPrice(0.01), '$0.01');
    assert.equal(formatPrice(0.123456), '$0.123456');
    assert.equal(formatPrice(0.5), '$0.50');
    assert.equal(formatPrice(-0.5), '$-0.50');
    assert.equal(formatPrice(12.5), '$12.50');
    assert.equal(formatPrice(1500), '$1,500');
    assert.equal(formatPrice(-1500), '$-1,500.00');
    assert.equal(formatPrice(NaN), '--');
    assert.equal(formatPrice(Infinity), '--');
    assert.equal(formatPrice(-Infinity), '--');
  });

  it('caps tiny prices at a short string', async () => {
    const { formatPrice } = await loadUtils();
    for (const value of [0.00024, 1e-8, 1e-12, 1e-20, -1e-20]) {
      const text = formatPrice(value);
      assert.ok(text.length <= 16, `${value} rendered ${JSON.stringify(text)}`);
      assert.notEqual(text, '$0');
      assert.notEqual(text, '$0.00');
      assert.notEqual(text, '$-0');
      assert.notEqual(text, '$-0.00');
    }
  });
});

describe('change formatting unavailable-state consistency', () => {
  it('formats non-finite changes as unavailable without directional styling', async () => {
    const { formatChange, getChangeClass, getHeatmapClass } = await loadUtils();
    for (const value of [undefined, null, NaN, Infinity, -Infinity]) {
      assert.equal(formatChange(value), '--');
      assert.equal(getChangeClass(value), '');
      assert.equal(getHeatmapClass(value), '');
    }
  });

  it('preserves directional classes and heatmap buckets for valid changes', async () => {
    const { formatChange, getChangeClass, getHeatmapClass } = await loadUtils();
    assert.equal(formatChange(1.234), '+1.23%');
    assert.equal(formatChange(-0.5), '-0.50%');
    assert.equal(getChangeClass(0), 'up');
    assert.equal(getChangeClass(-0.1), 'down');
    assert.equal(getHeatmapClass(0.25), 'up-1');
    assert.equal(getHeatmapClass(-1.25), 'down-2');
    assert.equal(getHeatmapClass(2), 'up-3');
  });

  it('applies the correct heatmap bucket at the abs 1 and 2 boundaries', async () => {
    const { getHeatmapClass } = await loadUtils();
    assert.equal(getHeatmapClass(0), 'up-1');
    assert.equal(getHeatmapClass(0.99), 'up-1');
    assert.equal(getHeatmapClass(1), 'up-2');
    assert.equal(getHeatmapClass(-1), 'down-2');
    assert.equal(getHeatmapClass(1.99), 'up-2');
    assert.equal(getHeatmapClass(-2), 'down-3');
  });
});
