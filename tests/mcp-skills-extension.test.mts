import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import handler from '../api/mcp.ts';

const endpoint = 'https://worldmonitor.app/mcp';
function request(method: string, params: Record<string, unknown> = {}, id = 1): Request {
  return new Request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

describe('Skills Over MCP extension', () => {
  it('advertises the extension and anonymously enumerates complete skill entries', async () => {
    const initialized = await handler(request('initialize', {
      protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    }));
    const initBody = await initialized.json() as any;
    assert.deepEqual(initBody.result.capabilities.extensions['io.modelcontextprotocol/skills'], {});

    const listed = await handler(request('skills/list'));
    const body = await listed.json() as any;
    assert.equal(listed.status, 200);
    assert.equal(body.result.resultType, 'complete');
    assert.ok(body.result.skills.length > 0);
    for (const skill of body.result.skills) {
      assert.equal(skill.uri, `skill://${skill.frontmatter.name}/SKILL.md`);
      assert.ok(skill.resources.some((resource: any) => resource.uri === skill.uri));
      for (const resource of skill.resources) {
        assert.match(resource.digest, /^sha256:[a-f0-9]{64}$/);
        assert.ok(Number.isSafeInteger(resource.size) && resource.size >= 0);
      }
    }
  });

  it('gets a skill by URI and reads its exact digest-bound resource anonymously', async () => {
    const got = await handler(request('skills/get', { uri: 'skill://check-country-risk/SKILL.md' }));
    const getBody = await got.json() as any;
    assert.equal(getBody.result.skill.frontmatter.name, 'check-country-risk');

    const read = await handler(request('resources/read', { uri: getBody.result.skill.uri }));
    const readBody = await read.json() as any;
    assert.equal(read.status, 200);
    assert.equal(readBody.result.contents[0].mimeType, 'text/markdown');
    assert.match(readBody.result.contents[0].text, /^---\nname: check-country-risk\n/);
  });

  it('rejects cursors and unknown skill URIs with Invalid params', async () => {
    const cursor = await handler(request('skills/list', { cursor: 'done' }));
    assert.equal((await cursor.json() as any).error.code, -32602);
    const missing = await handler(request('skills/get', { uri: 'skill://missing/SKILL.md' }));
    assert.equal((await missing.json() as any).error.code, -32602);
  });
});
