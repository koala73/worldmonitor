import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '..', 'src', 'components', 'McpConnectModal.ts'), 'utf-8');

describe('McpConnectModal refresh interval', () => {
  it('MIN_MCP_REFRESH_S constant is at least 60', () => {
    const m = src.match(/const\s+MIN_MCP_REFRESH_S\s*=\s*(\d+)/);
    assert.ok(m, 'MIN_MCP_REFRESH_S constant not found');
    assert.ok(Number(m![1]) >= 60, `MIN_MCP_REFRESH_S is ${m![1]}, expected >= 60`);
  });

  it('Math.max uses MIN_MCP_REFRESH_S constant', () => {
    assert.match(src, /Math\.max\(MIN_MCP_REFRESH_S,\s*parseInt\(refreshInput/, 'Math.max should use MIN_MCP_REFRESH_S');
  });

  it('HTML input min uses MIN_MCP_REFRESH_S constant', () => {
    assert.match(src, /min="\$\{MIN_MCP_REFRESH_S\}"/, 'HTML min should use MIN_MCP_REFRESH_S');
  });
});
