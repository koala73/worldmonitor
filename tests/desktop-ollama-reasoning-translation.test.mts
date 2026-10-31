import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Its own file, so the sidecar's patched fetch is installed fresh: another
// test in the same process may restore the native fetch after importing it.
const route = '/api/news/v1/summarize-article';
const payload = {
  provider: 'ollama', headlines: ['A new technology platform has been released.'],
  mode: 'translate', variant: 'de', lang: '',
};

test('desktop Ollama translation turns off reasoning and outlasts a silent model load', async () => {
  const originalEnv = { ...process.env };
  const nativeFetch = globalThis.fetch;
  const root = await mkdtemp(join(tmpdir(), 'desktop-translate-reasoning-'));
  const calls: Record<string, unknown>[] = [];
  const ollama = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(200);
      res.end('Ollama is running');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    calls.push(request);
    await new Promise(resolve => setTimeout(resolve, 400));
    const thinks = request.reasoning_effort !== 'none';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: thinks
          ? { content: '', reasoning: 'Okay, the user wants a German translation of' }
          : { content: 'Eine neue Technologieplattform wurde veröffentlicht.' },
        finish_reason: thinks ? 'length' : 'stop',
      }],
      usage: { total_tokens: 100 },
    }));
  });
  await new Promise<void>(resolve => ollama.listen(0, '127.0.0.1', resolve));
  const ollamaPort = (ollama.address() as { port: number }).port;
  for (const key of ['WORLDMONITOR_VALID_KEYS', 'WORLDMONITOR_API_KEY', 'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN', 'OPENROUTER_API_KEY', 'CONVEX_URL', 'VERCEL', 'VERCEL_ENV']) delete process.env[key];
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.LOCAL_API_TOKEN = 'synthetic-desktop-translation-token';
  process.env.OLLAMA_API_URL = `http://127.0.0.1:${ollamaPort}`;
  process.env.OLLAMA_MODEL = 'qwen3:8b';
  await mkdir(join(root, 'news/v1'), { recursive: true });
  await writeFile(join(root, 'news/v1/summarize-article.js'),
    `export { default } from ${JSON.stringify(new URL('../api/news/v1/[rpc].ts', import.meta.url).href)};`);
  const { createLocalApiServer, __testing__ } = await import('../src-tauri/sidecar/local-api-server.mjs');
  __testing__.setUpstreamIdleTimeoutMs(100);
  const app = await createLocalApiServer({ port: 0, apiDir: root, dataDir: root,
    mode: 'tauri-sidecar', cloudFallback: false, logger: { log() {}, warn() {}, error() {} } });
  const { port } = await app.start();
  try {
    const response = await nativeFetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worldmonitor-local-token': process.env.LOCAL_API_TOKEN },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    assert.equal(result.status, 'SUMMARIZE_STATUS_SUCCESS', JSON.stringify(result));
    assert.equal(result.summary, 'Eine neue Technologieplattform wurde veröffentlicht.');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.reasoning_effort, 'none');
    assert.equal('think' in calls[0]!, false, 'Ollama /v1/chat/completions ignores think');
  } finally {
    __testing__.setUpstreamIdleTimeoutMs(12000);
    await app.close();
    await new Promise<void>((resolve, reject) => ollama.close(err => err ? reject(err) : resolve()));
    await rm(root, { recursive: true, force: true });
    globalThis.fetch = nativeFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
});
