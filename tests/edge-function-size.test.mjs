import assert from 'node:assert/strict';
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
