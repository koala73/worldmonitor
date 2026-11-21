import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archives = [
  ['og', process.argv[2], '/iYJ34PDu4lty1TXdL86qHEw8viveHTllG1PWLuJX8tSFfqKL7kyVJeUORJmQ250bHB0h+alcalXUlza3c/NSA=='],
  ['harfbuzz', process.argv[3], 'SN8LVwCOzvTq3OPNd0+EAghgXugItz56wst567D1vs7LnnKGWprhi3EG58aVOBwhN8HEbQxL4I9NDWkcXUutRw=='],
];
const scratch = mkdtempSync(join(tmpdir(), 'vercel-og-backport-'));

// Returns the literal signature of every `addFunction(callback, "sig")` call.
// Callbacks are whole function bodies, so the closing parenthesis is found by
// depth. A call whose last argument is not a string literal fails the build.
function addFunctionSignatures(source) {
  const signatures = [];
  for (let start = source.indexOf('addFunction('); start !== -1; start = source.indexOf('addFunction(', start + 1)) {
    let depth = 0;
    let end = start + 'addFunction'.length;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    const signature = source.slice(start, end).match(/,\s*"([a-z]+)"\s*$/);
    if (!signature) throw new Error(`addFunction call without a literal signature: ${source.slice(start, start + 80)}`);
    signatures.push(signature[1]);
  }
  return signatures;
}

try {
  for (const [name, archive, integrity] of archives) {
    if (!archive) throw new Error('Usage: node scripts/vendor-vercel-og.mjs <og-1.0.3.tgz> <harfbuzzjs-0.10.0.tgz>');
    const bytes = readFileSync(archive);
    if (createHash('sha512').update(bytes).digest('base64') !== integrity) {
      throw new Error(`Unexpected ${name} archive integrity`);
    }
    const destination = join(scratch, name);
    mkdirSync(destination);
    execFileSync('tar', ['-xzf', resolve(archive), '-C', destination]);
  }

  const upstream = join(scratch, 'og', 'package');
  const harfbuzz = join(scratch, 'harfbuzz', 'package');
  const output = join(root, 'vendor', 'vercel-og');
  mkdirSync(join(output, 'dist'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'));
  manifest.version = '1.0.3-worldmonitor.2';
  manifest.private = true;
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.packageManager;
  writeFileSync(join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const name of ['Geist-Regular.ttf', 'resvg.wasm', 'yoga.wasm', 'index.node.d.ts', 'index.edge.d.ts', 'types.d.ts']) {
    copyFileSync(join(upstream, 'dist', name), join(output, 'dist', name));
  }
  copyFileSync(join(upstream, 'LICENSE'), join(output, 'LICENSE'));
  copyFileSync(join(harfbuzz, 'LICENSE'), join(output, 'LICENSE.harfbuzz'));
  const hbWasm = readFileSync(join(harfbuzz, 'hb.wasm'));
  writeFileSync(join(output, 'dist', 'harfbuzz.js'), `export default Uint8Array.from(atob("${hbWasm.toString('base64')}"), c => c.charCodeAt(0));\n`);
  // Vercel's Edge runtime refuses to compile WebAssembly from bytes, so the
  // Edge build imports HarfBuzz as a precompiled module instead.
  writeFileSync(join(output, 'dist', 'harfbuzz.wasm'), hbWasm);

  // Emscripten's addFunction wraps each JS callback in a tiny module compiled
  // from bytes at call time. hbjs calls it while loading and for glyph drawing.
  // The module bytes depend only on the signature's value types, so the Edge
  // build ships one precompiled module per type list it uses.
  const wasmTypeCodes = { i: 0x7f, p: 0x7f, j: 0x7e, f: 0x7d, d: 0x7c, e: 0x6f };
  const withLength = bytes => [bytes.length % 128 | 128, bytes.length >> 7, ...bytes];
  const typePack = types => withLength(Array.from(types, type => wasmTypeCodes[type]));
  const trampolineKey = sig => Array.from(sig, type => (type === 'p' ? 'i' : type)).join('');
  const trampolineBytes = sig => Uint8Array.of(
    0, 97, 115, 109, 1, 0, 0, 0, 1,
    ...withLength([1, 96, ...typePack(sig.slice(1)), ...typePack(sig[0] === 'v' ? '' : sig[0])]),
    2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0,
  );

  const sharedReplacements = [
    // HarfBuzz receives its binary from the bundle, so it must not enter the filesystem loader.
    ['var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer";', 'var ENVIRONMENT_IS_NODE = false;'],
    // This worker setup is unused by the bundled synchronous font decompressor.
    ['import { createRequire } from "module";\nvar require2 = createRequire("/");\nvar Worker;\ntry {\n  Worker = require2("worker_threads").Worker;\n} catch (e) {\n}', ''],
  ];
  const builds = {
    'index.node.js': {
      header: 'import harfbuzzWasm from "./harfbuzz.js";\n',
      replacements: [['hb().then((instance) => {', 'hb({ wasmBinary: harfbuzzWasm }).then((instance) => {']],
    },
    'index.edge.js': {
      header: 'import harfbuzzModule from "./harfbuzz.wasm?module";\n',
      replacements: [
        // Emscripten calls instantiateWasm(imports, receiveInstance) and
        // receiveInstance(instance, module). `reject` belongs to the
        // surrounding harfbuzzjs promise, so a failed instantiation rejects
        // the shaping promise instead of leaving it pending.
        ['hb().then((instance) => {', 'hb({ instantiateWasm(imports, receiveInstance) { WebAssembly.instantiate(harfbuzzModule, imports).then((instance) => receiveInstance(instance, harfbuzzModule), reject); return {}; } }).then((instance) => {'],
        ['var module2 = new WebAssembly.Module(bytes);\n          var instance = new WebAssembly.Instance(module2, { e: { f: func } });',
          'var module2 = harfbuzzTrampolines[Array.from(sig, (type) => type === "p" ? "i" : type).join("")] ?? new WebAssembly.Module(bytes);\n          var instance = new WebAssembly.Instance(module2, { e: { f: func } });'],
      ],
    },
  };
  for (const [name, { header, replacements }] of Object.entries(builds)) {
    let source = readFileSync(join(upstream, 'dist', name), 'utf8');
    for (const [before, after] of [...sharedReplacements, ...replacements]) {
      if (source.split(before).length !== 2) throw new Error(`Unexpected ${name} patch target`);
      source = source.replace(before, after);
    }
    source = source.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
    let prefix = header;
    if (name === 'index.edge.js') {
      const hbjs = source.slice(source.indexOf('var require_hbjs = __commonJS'), source.indexOf('var require_harfbuzzjs = __commonJS'));
      const signatures = addFunctionSignatures(hbjs);
      if (signatures.length === 0) throw new Error('Found no hbjs addFunction calls');
      const keys = [...new Set(signatures.map(trampolineKey))].sort();
      const entries = keys.map((key, index) => {
        writeFileSync(join(output, 'dist', `harfbuzz-fn-${key}.wasm`), trampolineBytes(key));
        prefix += `import harfbuzzFn${index} from "./harfbuzz-fn-${key}.wasm?module";\n`;
        return `${JSON.stringify(key)}: harfbuzzFn${index}`;
      });
      prefix += `var harfbuzzTrampolines = { ${entries.join(', ')} };\n`;
    }
    writeFileSync(join(output, 'dist', name), `${prefix}${source}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
