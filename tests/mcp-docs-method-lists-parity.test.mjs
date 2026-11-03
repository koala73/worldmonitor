// The MCP docs carry three hand-maintained method lists, in English and
// Chinese. They drifted from the handler once (skills/list and skills/get were
// added to PUBLIC_MCP_METHODS and to the dispatch switch, and to none of the
// lists), so pin each list to the handler source it describes.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const handler = read('api/mcp/handler.ts');
const CANONICAL_MCP_ENDPOINT = new URL('https://worldmonitor.app/mcp');
const MCP_TRANSPORT_PATHS = new Set(['/mcp', '/api/mcp']);

const publicMethodsBlock = handler.match(/const PUBLIC_MCP_METHODS[^=]*= new Set\(\[([\s\S]*?)\]\)/);
assert.ok(publicMethodsBlock, 'PUBLIC_MCP_METHODS literal not found in api/mcp/handler.ts');
const PUBLIC_METHODS = [...publicMethodsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const DISPATCHED_METHODS = [...handler.matchAll(/^ {4}case '([^']+)':/gm)].map((m) => m[1]);

/** The single paragraph (one line) of `file` that contains `marker`. */
function paragraph(file, marker) {
  const lines = read(file).split('\n').filter((line) => line.includes(marker));
  assert.equal(lines.length, 1, `${file}: expected exactly one line containing ${JSON.stringify(marker)}, found ${lines.length}`);
  return lines[0];
}

function assertNames(file, marker, methods) {
  const text = paragraph(file, marker);
  for (const method of methods) {
    assert.ok(text.includes(`\`${method}\``), `${file}: the ${JSON.stringify(marker)} paragraph does not name \`${method}\``);
  }
}

function publishedMcpTransportUrls(content) {
  return [...content.matchAll(/https?:\/\/[^\s`<>"')\]]+/g)]
    .flatMap(([value]) => {
      try {
        return [new URL(value)];
      } catch {
        return [];
      }
    })
    .filter((url) => MCP_TRANSPORT_PATHS.has(url.pathname));
}

describe('MCP docs method lists match api/mcp/handler.ts', () => {
  it('publishes only the canonical product transport endpoint', () => {
    for (const file of [
      'docs/usage-quickstart.mdx',
      'docs/mcp-overview.mdx',
      'docs/zh/usage-quickstart.mdx',
      'docs/zh/mcp-overview.mdx',
    ]) {
      const endpoints = publishedMcpTransportUrls(read(file));
      assert.ok(
        endpoints.some((url) => url.href === CANONICAL_MCP_ENDPOINT.href),
        `${file}: canonical MCP endpoint missing`,
      );
      assert.ok(
        endpoints.every((url) => url.href === CANONICAL_MCP_ENDPOINT.href),
        `${file}: non-canonical MCP endpoint published`,
      );
    }
  });

  it('does not accept a canonical endpoint embedded in another URL', () => {
    const endpoints = publishedMcpTransportUrls('https://untrusted.example/?target=https://worldmonitor.app/mcp');
    assert.deepEqual(endpoints, []);
  });

  it('reads a plausible method set from the handler', () => {
    assert.ok(PUBLIC_METHODS.includes('tools/list') && PUBLIC_METHODS.includes('initialize'));
    assert.ok(DISPATCHED_METHODS.includes('tools/call') && DISPATCHED_METHODS.length >= PUBLIC_METHODS.length);
  });

  for (const [file, marker] of [
    ['docs/mcp-error-catalog.mdx', '**Per-minute throttle'],
    ['docs/zh/mcp-error-catalog.mdx', '**每分钟节流'],
  ]) {
    it(`${file}: the credential-less discovery list names every PUBLIC_MCP_METHODS entry`, () => {
      assertNames(file, marker, PUBLIC_METHODS);
    });
  }

  // `initialize` is public only on the discovery aliases; this paragraph is
  // about the transport, where it is challenged, so it is deliberately absent.
  for (const [file, marker] of [
    ['docs/mcp-overview.mdx', '**Stateless catalog reads stay public.**'],
    ['docs/zh/mcp-overview.mdx', '**无状态的目录读取保持公开。**'],
  ]) {
    it(`${file}: the stateless-reads paragraph names every public method except initialize`, () => {
      assertNames(file, marker, PUBLIC_METHODS.filter((m) => m !== 'initialize'));
    });
  }

  for (const [file, marker] of [
    ['docs/mcp-overview.mdx', 'do **not** count against the daily cap'],
    ['docs/zh/mcp-overview.mdx', '**不**计入每日上限'],
  ]) {
    it(`${file}: the quota-exempt list names every PUBLIC_MCP_METHODS entry`, () => {
      const lines = read(file).split('\n').filter((l) => l.includes(marker) && l.includes('`logging/setLevel`'));
      assert.equal(lines.length, 1, `${file}: quota-exempt bullet not found`);
      for (const method of PUBLIC_METHODS) {
        assert.ok(lines[0].includes(`\`${method}\``), `${file}: the quota-exempt list does not name \`${method}\``);
      }
    });
  }

  for (const [file, marker] of [
    ['docs/mcp-error-catalog.mdx', 'Methods this server speaks:'],
    ['docs/zh/mcp-error-catalog.mdx', '本服务器支持的方法：'],
  ]) {
    it(`${file}: the -32601 method list names every dispatched method`, () => {
      assertNames(file, marker, DISPATCHED_METHODS);
    });
  }

  it('the Chinese -32029 summary row covers the anonymous ceiling like the English row', () => {
    const row = (file) => read(file).split('\n').find((l) => l.startsWith('| `-32029`'));
    assert.match(row('docs/mcp-error-catalog.mdx'), /anon/i);
    assert.match(row('docs/zh/mcp-error-catalog.mdx'), /匿名/);
  });
});
