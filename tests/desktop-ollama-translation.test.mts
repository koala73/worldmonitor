import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import newsGateway from '../api/news/v1/[rpc].ts';

const route = '/api/news/v1/summarize-article';
const payload = {
  provider: 'ollama', headlines: ['Breaking news'], mode: 'translate', variant: 'de', lang: '',
};

test('desktop Ollama translation uses native transport auth without a World Monitor key', async () => {
  const originalEnv = { ...process.env };
  const nativeFetch = globalThis.fetch;
  const root = await mkdtemp(join(tmpdir(), 'desktop-translate-'));
  const calls: Record<string, unknown>[] = [];
  let providerDown = false;
  const ollama = createServer(async (req, res) => {
    if (req.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.push(JSON.parse(body));
      res.writeHead(providerDown ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(providerDown ? { error: 'provider unavailable' } : {
        choices: [{ message: { content: 'Aktuelle Nachrichten' } }], usage: { total_tokens: 10 },
      }));
    } else {
      res.writeHead(200);
      res.end('Ollama is running');
    }
  });
  await new Promise<void>(resolve => ollama.listen(0, '127.0.0.1', resolve));
  const ollamaPort = (ollama.address() as { port: number }).port;
  for (const key of ['WORLDMONITOR_VALID_KEYS', 'WORLDMONITOR_API_KEY', 'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN', 'OPENROUTER_API_KEY', 'CONVEX_URL', 'VERCEL', 'VERCEL_ENV']) delete process.env[key];
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.LOCAL_API_TOKEN = 'synthetic-desktop-translation-token';
  delete process.env.OLLAMA_API_URL;
  process.env.OLLAMA_MODEL = 'qwen3:8b';
  await mkdir(join(root, 'news/v1'), { recursive: true });
  await writeFile(join(root, 'news/v1/summarize-article.js'),
    `export { default } from ${JSON.stringify(new URL('../api/news/v1/[rpc].ts', import.meta.url).href)};`);
  const { createLocalApiServer } = await import('../src-tauri/sidecar/local-api-server.mjs');
  const app = await createLocalApiServer({ port: 0, apiDir: root, dataDir: root,
    mode: 'tauri-sidecar', cloudFallback: false, logger: { log() {}, warn() {}, error() {} } });
  const { port } = await app.start();
  const send = (body: unknown, token = process.env.LOCAL_API_TOKEN) => nativeFetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-worldmonitor-local-token': token ?? '' },
    body: JSON.stringify(body),
  });
  try {
    for (const token of ['', 'wrong-token']) {
      const denied = await send(payload, token);
      assert.equal(denied.status, 401);
      assert.equal((await denied.json()).error, 'Unauthorized');
    }
    assert.equal(calls.length, 0);
    const configureOllama = (value: string) => nativeFetch(`http://127.0.0.1:${port}/api/local-env-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worldmonitor-local-token': process.env.LOCAL_API_TOKEN! },
      body: JSON.stringify({ key: 'OLLAMA_API_URL', value }),
    });
    assert.equal((await configureOllama(`http://127.0.0.1:${ollamaPort}`)).status, 200);
    const health = await nativeFetch(`http://127.0.0.1:${port}/api/llm-health`, {
      headers: { 'x-worldmonitor-local-token': process.env.LOCAL_API_TOKEN! },
    });
    assert.equal((await health.json()).available, true);
    const translated = await send(payload);
    assert.equal(translated.status, 200, await translated.clone().text());
    assert.equal((await translated.json()).summary, 'Aktuelle Nachrichten');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.model, 'qwen3:8b');
    assert.match(JSON.stringify(calls[0]!.messages), /Translate to de:/);

    for (const body of [{ ...payload, mode: 'brief' }, { ...payload, provider: 'openrouter' }]) {
      assert.equal((await send(body)).status, 401, JSON.stringify(body));
    }
    const invalid = await send({ ...payload, variant: 'unsupported' });
    assert.equal((await invalid.json()).errorType, 'ValidationError');
    assert.equal(calls.length, 1);

    assert.equal((await configureOllama('')).status, 200);
    assert.equal((await (await send(payload)).json()).status, 'SUMMARIZE_STATUS_SKIPPED');
    assert.equal((await configureOllama(`http://127.0.0.1:${ollamaPort}`)).status, 200);

    providerDown = true;
    const unavailable = await send({ ...payload, headlines: ['Different headline'] });
    const failure = await unavailable.json();
    assert.equal(failure.status, 'SUMMARIZE_STATUS_ERROR');
    assert.equal(failure.summary, '');

    for (const mode of ['', 'docker']) {
      process.env.LOCAL_API_MODE = mode;
      const cloud = await newsGateway(new Request(`https://api.worldmonitor.app${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'LOCAL_API_MODE': 'tauri-sidecar' },
        body: JSON.stringify(payload),
      }));
      assert.equal(cloud.status, 401, `deployment mode ${mode}`);
    }
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => ollama.close(err => err ? reject(err) : resolve()));
    await rm(root, { recursive: true, force: true });
    globalThis.fetch = nativeFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
});
