import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { build } from 'esbuild';
import { EdgeVM } from '@edge-runtime/vm';

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve('@vercel/og/package.json'));

// Vercel's Edge runtime refuses to compile WebAssembly from bytes at runtime
// ("Wasm code generation disallowed by embedder"). Every binary must arrive as
// a precompiled `?module` import. EdgeVM allows compilation unless told not to,
// so this check disables it and compiles the `?module` imports on the host,
// as Vercel does when it deploys the function.
it('renders the installed OG package in an Edge runtime without Node modules or runtime Wasm compilation', async () => {
  const font = await readFile(join(packageDir, 'dist/Geist-Regular.ttf'));
  const wasmPaths = new Set();
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
        builder.onLoad({ filter: /.*/, namespace: 'edge-wasm' }, args => {
          wasmPaths.add(args.path);
          return { contents: `export default globalThis.__edgeWasmModules[${JSON.stringify(args.path)}];` };
        });
      },
    }],
  });
  const vm = new EdgeVM({
    codeGeneration: { strings: false, wasm: false },
    extend(context) {
      context.fetch = async input => {
        assert.equal(String(input), 'https://renderer.test/Geist-Regular.ttf');
        return new context.Response(font);
      };
      return context;
    },
  });
  // Guard the guard: the VM must refuse byte compilation the way Vercel does.
  await assert.rejects(
    vm.evaluate('WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))'),
    /Wasm code generation disallowed by embedder/,
  );
  const modules = {};
  const edgeModulePrototype = vm.evaluate('WebAssembly.Module.prototype');
  for (const path of wasmPaths) {
    const module = new WebAssembly.Module(await readFile(path));
    // Host-compiled, so give it the VM realm's prototype for instanceof checks.
    Object.setPrototypeOf(module, edgeModulePrototype);
    modules[path] = module;
  }
  vm.context.__edgeWasmModules = modules;
  vm.evaluate(result.outputFiles[0].text);
  const png = await vm.evaluate(`(async () => {
    const response = new og.ImageResponse({ type: 'div', props: { children: 'World Monitor' } });
    return new Uint8Array(await response.arrayBuffer());
  })()`);
  assert.deepEqual(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.byteLength > 1000);
});

it('ships a precompiled HarfBuzz callback module for every addFunction signature in the Edge build', async () => {
  const source = await readFile(join(packageDir, 'dist/index.edge.js'), 'utf8');
  assert.match(source, /^import harfbuzzModule from "\.\/harfbuzz\.wasm\?module";$/m);
  assert.doesNotMatch(source, /harfbuzz\.js|wasmBinary: harfbuzzWasm/);
  const hbjs = source.slice(source.indexOf('var require_hbjs = __commonJS'), source.indexOf('var require_harfbuzzjs = __commonJS'));
  const shipped = new Set([...source.matchAll(/^import harfbuzzFn\d+ from "\.\/harfbuzz-fn-([a-z]+)\.wasm\?module";$/gm)].map(match => match[1]));
  const used = [...hbjs.matchAll(/,\s*"([vipjfde]+)"\)/g)].map(match => match[1].replaceAll('p', 'i'));
  assert.ok(used.length >= 19, `expected the hbjs addFunction calls, found ${used.length}`);
  for (const key of used) assert.ok(shipped.has(key), `no precompiled HarfBuzz callback module for ${key}`);
});

it('instantiates every shipped HarfBuzz callback module without runtime Wasm compilation', async () => {
  const { readdir } = await import('node:fs/promises');
  const vm = new EdgeVM({ codeGeneration: { strings: false, wasm: false } });
  const files = (await readdir(join(packageDir, 'dist'))).filter(name => /^harfbuzz-fn-[a-z]+\.wasm$/.test(name));
  assert.ok(files.length > 0);
  for (const name of files) {
    const module = new WebAssembly.Module(await readFile(join(packageDir, 'dist', name)));
    assert.deepEqual(WebAssembly.Module.imports(module), [{ module: 'e', name: 'f', kind: 'function' }], name);
    assert.deepEqual(WebAssembly.Module.exports(module), [{ name: 'f', kind: 'function' }], name);
    vm.context.__callbackModule = module;
    const result = vm.evaluate('typeof new WebAssembly.Instance(__callbackModule, { e: { f() { return 0; } } }).exports.f');
    assert.equal(result, 'function', name);
  }
});
