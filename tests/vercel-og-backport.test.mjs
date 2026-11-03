import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { build } from 'esbuild';
import { EdgeVM } from '@edge-runtime/vm';

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve('@vercel/og/package.json'));

it('renders the installed OG package in an Edge runtime without Node modules', async () => {
  const font = await readFile(join(packageDir, 'dist/Geist-Regular.ttf'));
  const result = await build({
    entryPoints: [join(packageDir, 'dist/index.edge.js')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'og',
    define: {
      'import.meta.url': '"https://renderer.test/index.edge.js"',
      'process.env.NODE_ENV': '"production"',
    },
    plugins: [{
      name: 'edge-wasm',
      setup(builder) {
        builder.onResolve({ filter: /\.wasm\?module$/ }, args => ({
          path: join(args.resolveDir, args.path.replace('?module', '')),
          namespace: 'edge-wasm',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'edge-wasm' }, async args => {
          const binary = await readFile(args.path);
          return { contents: `export default new WebAssembly.Module(Uint8Array.from(atob("${binary.toString('base64')}"), c => c.charCodeAt(0)));` };
        });
      },
    }],
  });
  const vm = new EdgeVM({
    extend(context) {
      context.fetch = async input => {
        assert.equal(String(input), 'https://renderer.test/Geist-Regular.ttf');
        return new context.Response(font);
      };
      return context;
    },
  });
  vm.evaluate(result.outputFiles[0].text);
  const png = await vm.evaluate(`(async () => {
    const response = new og.ImageResponse({ type: 'div', props: { children: 'World Monitor' } });
    return new Uint8Array(await response.arrayBuffer());
  })()`);
  assert.deepEqual(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.byteLength > 1000);
});
