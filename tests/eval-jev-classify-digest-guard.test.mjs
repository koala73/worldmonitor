import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/eval-jev-classify.mjs', import.meta.url));

// A fake Upstash REST endpoint: GET returns the digest under test, MGET returns no cached labels.
let server;
let digest;
let url;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const [command, ...keys] = JSON.parse(body);
      const result = command === 'GET' ? JSON.stringify(digest) : keys.map(() => null);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function runEval() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--variants', 'full', '--shapes', 'single'], {
      env: {
        PATH: process.env.PATH,
        TYPESAFE_API_KEY: 'test-key',
        UPSTASH_REDIS_REST_URL: url,
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      },
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

describe('eval-jev-classify digest guard', () => {
  it('refuses a digest whose categories map is empty', async () => {
    digest = { categories: {} };
    const { code, stderr } = await runEval();
    assert.notEqual(code, 0);
    assert.match(stderr, /no usable digest for variant "full"/);
  });

  it('refuses a digest whose buckets hold no titled items', async () => {
    digest = { categories: { world: { items: [] }, tech: { items: [{ title: '' }, {}] } } };
    const { code, stderr } = await runEval();
    assert.notEqual(code, 0);
    assert.match(stderr, /no usable digest for variant "full"/);
  });

  it('accepts a digest with a titled item and gets past the guard', async () => {
    digest = { data: { categories: { world: { items: [{ title: 'Example headline' }] } } } };
    const { stderr } = await runEval();
    assert.doesNotMatch(stderr, /no usable digest/);
    assert.match(stderr, /full: 1 new titles/);
  });
});
