import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';
import { createLocalApiServer } from './local-api-server.mjs';

function executeBridge(html) {
  const parserWindow = new Window();
  const document = new parserWindow.DOMParser().parseFromString(html, 'text/html');
  const script = document.querySelector('script')?.textContent;
  parserWindow.close();
  assert.ok(script, 'execute the actual served bridge');
  const calls = [];
  const parent = { postMessage() {} };
  let receive;
  const sandbox = {
    window: { parent, addEventListener(type, listener) { if (type === 'message') receive = listener; } },
    document: {
      createElement: () => ({}), head: { appendChild() {} },
      getElementById: () => ({ classList: { add() {}, remove() {} } }),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
  };
  runInNewContext(script, sandbox);
  sandbox.player = { getPlayerState: () => 1 };
  for (const method of ['playVideo', 'pauseVideo', 'mute', 'unMute', 'loadVideoById', 'setPlaybackQuality']) {
    sandbox.player[method] = (...args) => calls.push([method, ...args]);
  }
  assert.equal(typeof receive, 'function');
  return { receive, parent, calls };
}

test('youtube embed commands require the configured origin AND the parent window', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'youtube-message-'));
  const app = await createLocalApiServer({ port: 0, apiDir: dir, dataDir: dir, cloudFallback: false,
    logger: { log() {}, warn() {}, error() {} } });
  try {
    const { port } = await app.start();
    const commands = [
      [{ type: 'play' }, ['playVideo']], [{ type: 'pause' }, ['pauseVideo']],
      [{ type: 'mute' }, ['mute']], [{ type: 'unmute' }, ['unMute']],
      [{ type: 'loadVideo', videoId: 'e34xb-Fbl0U' }, ['loadVideoById', 'e34xb-Fbl0U']],
      [{ type: 'setQuality', quality: 'hd720' }, ['setPlaybackQuality', 'hd720']],
    ];
    const allowed = ['tauri://localhost', 'asset://localhost', 'http://localhost:5173',
      'https://localhost:5173', 'http://localhost', 'https://localhost',
      'http://tauri.localhost', 'https://tauri.localhost', 'https://app.tauri.localhost:1420'];
    for (const origin of [...allowed, '', 'null', 'https://evil.example', '</script><script>throw new Error("injected")</script>']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/youtube-embed?videoId=e34xb-Fbl0U&parentOrigin=${encodeURIComponent(origin)}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(!html.includes('throw new Error("injected")'), 'rejected parent must not enter inline script');
      const { receive, parent, calls } = executeBridge(html);
      for (const [data] of commands) {
        for (const sender of [
          { origin: 'https://evil.example', source: parent },
          { origin, source: {} }, { origin, source: null },
          { origin: 'null', source: parent },
          { origin: origin === 'http://localhost:5173' ? 'http://localhost:5174' : 'http://localhost:5173', source: parent },
          { origin: `${origin}:9999`, source: parent },
        ]) receive({ ...sender, data });
      }
      assert.deepEqual(calls, [], `reject wrong origin or source for ${origin}`);
      for (const [data] of commands) receive({ origin, source: parent, data });
      assert.deepEqual(calls, allowed.includes(origin) ? commands.map(([, expected]) => expected) : [],
        `only a supported exact parent can control playback: ${origin}`);
    }
  } finally {
    if (app.server.listening) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
