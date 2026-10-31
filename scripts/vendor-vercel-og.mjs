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
  manifest.version = '1.0.3-worldmonitor.1';
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
  const wasm = readFileSync(join(harfbuzz, 'hb.wasm')).toString('base64');
  writeFileSync(join(output, 'dist', 'harfbuzz.js'), `export default Uint8Array.from(atob("${wasm}"), c => c.charCodeAt(0));\n`);

  const replacements = [
    // HarfBuzz already receives its binary, so it must not enter the filesystem loader.
    ['var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer";', 'var ENVIRONMENT_IS_NODE = false;'],
    ['hb().then((instance) => {', 'hb({ wasmBinary: harfbuzzWasm }).then((instance) => {'],
    // This worker setup is unused by the bundled synchronous font decompressor.
    ['import { createRequire } from "module";\nvar require2 = createRequire("/");\nvar Worker;\ntry {\n  Worker = require2("worker_threads").Worker;\n} catch (e) {\n}', ''],
  ];
  for (const name of ['index.node.js', 'index.edge.js']) {
    let source = readFileSync(join(upstream, 'dist', name), 'utf8');
    for (const [before, after] of replacements) {
      if (source.split(before).length !== 2) throw new Error(`Unexpected ${name} patch target`);
      source = source.replace(before, after);
    }
    source = source.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
    writeFileSync(join(output, 'dist', name), `import harfbuzzWasm from "./harfbuzz.js";\n${source}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
