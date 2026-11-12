import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

// Run in the normal unit-shards inventory. These reproducible esbuild + gzip-9
// budgets are an early warning, not a substitute for Vercel's deployed artifact
// measurement. MCP reserves 24 KiB below the 1 MiB Edge ceiling; displacement
// gets a separate 300 KiB growth budget even though it has more platform room.
for (const [entry, budget] of [
  ['api/mcp.ts', 1024 * 1000],
  ['api/displacement/v1/[rpc].ts', 300 * 1024],
]) {
  test(`${entry} stays within its compressed function budget`, async (t) => {
    const result = await build({
      entryPoints: [entry], bundle: true, minify: true, write: false,
      format: 'esm', platform: 'browser', target: 'es2022',
    });
    const bytes = gzipSync(result.outputFiles[0].contents, { level: 9 }).length;
    t.diagnostic(`${bytes} bytes gzip-9 / ${budget} byte budget`);
    assert.ok(bytes <= budget, `${entry}: ${bytes} bytes exceeds ${budget}; reduce the bundle before shipping`);
  });
}

// `import { z }` binds zod's namespace object as a value, so esbuild keeps every
// zod export, all locales included: about 63 KB gzip in api/mcp.ts.
// docs/solutions/performance-issues/zod-named-z-import-bloats-edge-bundle.md
// Type-only imports (`import type { z }`, `import { type z }`) are erased and stay allowed.
// Anchoring at line start skips commented-out imports and quoted fixtures.
function importsZodValueZ(source) {
  for (const [, typeOnly, specifiers] of source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]zod['"]/gm)) {
    if (typeOnly) continue;
    if (specifiers.split(',').some((s) => /^z(\s+as\s+\w+)?$/.test(s.trim()))) return true;
  }
  return false;
}

test('the zod import guard flags value imports of z and allows type-only ones', () => {
  for (const flagged of ["import { z } from 'zod';", 'import { ZodError, z } from "zod";', "import {\n  z as zod,\n} from 'zod';"]) {
    assert.equal(importsZodValueZ(flagged), true, flagged);
  }
  for (const allowed of ["import * as z from 'zod';", "import type { z } from 'zod';", "import { type z } from 'zod';", "import { ZodError } from 'zod';", "import { zz } from 'zod';", "// import { z } from 'zod';", "const fixture = \"import { z } from 'zod';\";"]) {
    assert.equal(importsZodValueZ(allowed), false, allowed);
  }
});

test('source files import zod as a namespace, not the named z object', () => {
  const files = execFileSync('git', ['grep', '-l', 'zod', '--', '*.ts', '*.tsx', '*.mts', '*.js', '*.mjs', ':!tests/edge-function-size.test.mjs'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const hits = files.filter((f) => importsZodValueZ(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, [], `use \`import * as z from 'zod'\` in: ${hits.join(', ')}`);
});
