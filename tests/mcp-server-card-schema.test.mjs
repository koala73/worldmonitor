// Both MCP server cards must validate against the Server Card extension schema
// (SEP-2127, successor to SEP-1649). tests/fixtures/mcp-server-card.schema.json
// is a pinned copy of schema.json from
// modelcontextprotocol/experimental-ext-server-card; its published $schema URL
// does not resolve yet. Scanners such as geo.new mark a card Invalid when
// `$schema` is missing. The card's other keys (serverInfo, transport, tools, ...)
// are additional properties the schema allows.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
const CARDS = ['server-card.json', 'docs-server-card.json'];

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

const schema = readJson('./fixtures/mcp-server-card.schema.json');
// The schema's only format is `uri`; ajv-formats is not a dependency. WHATWG
// URL parsing alone accepts strings RFC 3986 forbids (it percent-encodes a
// space), so also require a scheme and only RFC 3986 characters.
const RFC3986_URI = /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/;
const isUri = (value) => RFC3986_URI.test(value) && URL.canParse(value);
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat('uri', isUri);
const validate = ajv.compile({ ...schema, $ref: '#/$defs/ServerCard' });

describe('MCP server card schema conformance', () => {
  for (const file of CARDS) {
    it(`${file} validates against the v1 Server Card schema`, () => {
      const card = readJson(`../public/.well-known/mcp/${file}`);
      assert.equal(card.$schema, SERVER_CARD_SCHEMA);
      assert.ok(validate(card), `${file}: ${ajv.errorsText(validate.errors)}`);
    });
  }

  it('the uri format rejects values RFC 3986 forbids', () => {
    for (const bad of ['https://example.com/a b', 'not a uri', '/relative/path', 'https://example.com/%zz', 'https://exa<mple.com']) {
      assert.equal(isUri(bad), false, bad);
    }
    for (const good of ['https://www.worldmonitor.app/favico/apple-touch-icon.png', 'https://example.com/a%20b?q=1#x', 'mailto:ops@example.com']) {
      assert.equal(isUri(good), true, good);
    }
  });

  it('the product card name matches the MCP Registry server.json name', () => {
    assert.equal(readJson('../public/.well-known/mcp/server-card.json').name, readJson('../server.json').name);
  });
});
