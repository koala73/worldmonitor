import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import policy from './shared/agent-request-policy.json' with { type: 'json' };

const origin = new URL(process.argv[2] ?? 'https://www.worldmonitor.app').origin;
const checks = [];

async function check(name, path, headers, verify) {
  try {
    const response = await fetch(new URL(path, origin), {
      headers: { 'User-Agent': 'WorldMonitor-ReadinessCheck/1.0', ...headers },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    await verify(response, body);
    checks.push({ name, pass: true, status: response.status });
  } catch (error) {
    checks.push({ name, pass: false, error: error.message });
  }
}

function assertMarkdownResponse(response, body) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/markdown/);
  assert.doesNotMatch(body.slice(0, 1000), /<!doctype html|<html/i);
}

function markdown(response, body) {
  assertMarkdownResponse(response, body);
  assert.match(body, /^---\n[\s\S]*?\btitle:[\s\S]*?\n---\n/);
  assert.match(body, /^canonical: /m);
}

function authMarkdown(response, body) {
  assertMarkdownResponse(response, body);
  assert.match(body, /^# WorldMonitor — Agent Authentication \(auth\.md\)\n/);
  assert.match(response.headers.get('link') ?? '', /<https:\/\/www\.worldmonitor\.app\/auth\.md>;\s*rel="canonical"/);
}

await check('JSON agent mode', '/?mode=agent', { Accept: 'application/json' }, (response, body) => {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const view = JSON.parse(body);
  assert.equal(view.kind, 'agent-view');
  assert.ok(view.endpoints.rest.openapi && view.authentication.apiKey && view.capabilities.length);
});

const docs = readdirSync(new URL('../public/', import.meta.url)).filter(
  (name) => name.endsWith('.md') && name !== 'auth.md',
);
docs.push('api/download.md', 'countries.md', 'sources.md', 'contact.md');
for (const document of docs) await check(document, `/${document}`, {}, markdown);
await check('auth.md', '/auth.md', {}, authMarkdown);
for (const ua of policy.userAgents) {
  await check(`${ua} homepage`, '/', { 'User-Agent': `${ua}/1.0`, Accept: 'text/html' }, markdown);
}
await check('browser homepage', '/', { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' }, (response, body) => {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(body, /<!doctype html|<html/i);
});
for (const ua of ['ora-agent', 'WorldMonitor-ReadinessCheck/1.0']) {
  await check(`${ua} API error`, '/api/agent-readiness-missing-endpoint', {
    'User-Agent': ua, Accept: 'application/json',
  }, (response, body) => {
    assert.ok(response.status >= 400 && response.status < 500);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const payload = JSON.parse(body);
    const error = typeof payload.error === 'object' ? payload.error : payload;
    assert.ok(error.code && error.message && error.hint);
  });
}
console.log(JSON.stringify({ origin, passed: checks.filter((check) => check.pass).length, total: checks.length, checks }, null, 2));
if (checks.some((check) => !check.pass)) process.exitCode = 1;
