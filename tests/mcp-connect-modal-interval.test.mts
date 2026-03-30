import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '..', 'src', 'components', 'McpConnectModal.ts'), 'utf-8');

describe('McpConnectModal refresh interval', () => {
  it('Math.max minimum is at least 60', () => {
    const m = src.match(/Math\.max\((\d+),\s*parseInt\(refreshInput/);
    assert.ok(m, 'Math.max(N, parseInt(refreshInput...)) not found');
    assert.ok(Number(m![1]) >= 60, `Math.max floor is ${m![1]}, expected >= 60`);
  });

  it('HTML input min attribute is at least 60', () => {
    const m = src.match(/mcp-refresh-input.*?min="(\d+)"/);
    assert.ok(m, 'mcp-refresh-input min attribute not found');
    assert.ok(Number(m![1]) >= 60, `HTML min is ${m![1]}, expected >= 60`);
  });
});
