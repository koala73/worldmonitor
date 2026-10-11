import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { getLocalMcpServer, getLocalMcpOrigins, isLocalMcpUrlAllowed, localMcpServerName } from '../scripts/shared/local-mcp-config.mjs';

const entry = { url: 'http://127.0.0.1:8080/mcp', headers: { Authorization: { env: 'LOCAL_TOKEN', prefix: 'Bearer ' } } };
const environment = (config = { osint: entry }) => ({
  LOCAL_API_MODE: 'docker', MCP_LOCAL_SERVERS: JSON.stringify(config), LOCAL_TOKEN: 'fixture-secret',
});

describe('operator local MCP configuration', () => {
  it('resolves only named targets and server-held credential references', () => {
    const env = environment();
    const server = getLocalMcpServer(localMcpServerName('mcp-local://osint'), env);
    assert.equal(server.url.href, entry.url);
    assert.deepEqual(server.headers, { Authorization: 'Bearer fixture-secret' });
    assert.deepEqual(getLocalMcpOrigins(env), ['http://127.0.0.1:8080']);
    assert.equal(getLocalMcpServer('missing', env), null);
    assert.equal(getLocalMcpServer('toString', env), null);
  });

  for (const mode of [undefined, '', 'production', 'edge']) {
    it(`is disabled outside explicit local modes (${String(mode)})`, () => {
      const env = { ...environment(), LOCAL_API_MODE: mode };
      assert.equal(getLocalMcpServer('osint', env), null);
      assert.deepEqual(getLocalMcpOrigins(env), []);
    });
  }
  for (const mode of ['docker', 'desktop-sidecar', 'tauri-sidecar']) {
    it(`supports the ${mode} runtime`, () => {
      assert.ok(getLocalMcpServer('osint', { ...environment(), LOCAL_API_MODE: mode }));
    });
  }

  for (const alias of ['mcp-local://osint/other', 'mcp-local://osint?env=LOCAL_TOKEN', 'mcp-local://osint#x', 'mcp-local://user@osint', 'mcp-local://osint:80', 'http://127.0.0.1/mcp']) {
    it(`rejects alias injection: ${alias}`, () => assert.equal(localMcpServerName(alias), null));
  }

  for (const invalid of [
    { url: 'file:///etc/passwd' }, { url: 'http://user:password@localhost/mcp' },
    { url: 'http://localhost/mcp#fragment' }, { url: 'bad-url' },
    { ...entry, headers: { Authorization: 'literal-secret' } },
    { ...entry, headers: { Authorization: { env: 'MISSING_TOKEN' } } },
    { ...entry, headers: { Authorization: { env: 'LOCAL_TOKEN', prefix: 'Bearer\r\nx-evil: ' } } },
    { ...entry, headers: { Host: { env: 'LOCAL_TOKEN' } } },
    { ...entry, headers: { 'Metadata-Flavor': { env: 'LOCAL_TOKEN' } } },
    { ...entry, headers: { Authorization: { env: 'LOCAL_TOKEN' }, authorization: { env: 'LOCAL_TOKEN' } } },
  ]) {
    it(`fails closed for invalid configuration ${JSON.stringify(invalid)}`, () => {
      assert.equal(getLocalMcpServer('osint', environment({ osint: invalid })), null);
    });
  }

  it('rejects malformed configuration and CRLF in credential values', () => {
    for (const raw of ['{', 'null', '[]', '{}'.repeat(40000)]) {
      assert.equal(getLocalMcpServer('osint', { ...environment(), MCP_LOCAL_SERVERS: raw }), null);
    }
    assert.equal(getLocalMcpServer('osint', { ...environment(), LOCAL_TOKEN: 'secret\r\nx-evil: value' }), null);
  });

  it('limits HTTP to its configured URL and SSE message endpoints to the configured origin', () => {
    const server = getLocalMcpServer('osint', environment());
    assert.ok(isLocalMcpUrlAllowed(new URL(entry.url), server));
    assert.equal(isLocalMcpUrlAllowed(new URL('http://127.0.0.1:8080/other'), server), false);
    assert.ok(isLocalMcpUrlAllowed(new URL('http://127.0.0.1:8080/messages?session=1'), server, { sseEndpoint: true }));
    for (const url of ['http://127.0.0.1:8081/messages', 'https://127.0.0.1:8080/messages', 'http://evil.test/messages', 'http://u:p@127.0.0.1:8080/messages', 'http://127.0.0.1:8080/messages#fragment']) {
      assert.equal(isLocalMcpUrlAllowed(new URL(url), server, { sseEndpoint: true }), false);
    }
  });
});
