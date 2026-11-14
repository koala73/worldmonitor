import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './embed.js';
import { TRUSTED_RETURN_URL_ORIGINS } from '../../convex/payments/returnUrlOrigin.ts';

function makeRequest(query = '') {
  return new Request(`https://worldmonitor.app/api/youtube/embed${query}`);
}

async function render(query) {
  const html = await (await handler(makeRequest(query))).text();
  const json = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)]
    .find((m) => /\bid="player-config"/i.test(m[1]))?.[2];
  assert.ok(json, 'embed page must carry its player config');
  return { html, config: JSON.parse(json) };
}

test('rejects missing or invalid video ids', async () => {
  const missing = await handler(makeRequest());
  assert.equal(missing.status, 400);

  const invalid = await handler(makeRequest('?videoId=bad'));
  assert.equal(invalid.status, 400);
});

test('returns embeddable html for valid video id', async () => {
  const response = await handler(makeRequest('?videoId=iEpJwprxDdk&autoplay=0&mute=1'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type')?.includes('text/html'), true);

  const { html, config } = await render('?videoId=iEpJwprxDdk&autoplay=0&mute=1');
  assert.deepEqual(config, {
    videoId: 'iEpJwprxDdk', autoplay: 0, mute: 1, vq: '',
    origin: 'https://worldmonitor.app', parentOrigin: 'https://worldmonitor.app',
  });
  assert.equal(html.includes('videoId:config.videoId'), true);
  assert.equal(html.includes("host:'https://www.youtube.com'"), true);
  assert.equal(html.includes('playerVars:{autoplay:config.autoplay,mute:config.mute,'), true);
  assert.equal(html.includes('postMessage'), true);
});

test('the player script is the same for every request', async () => {
  // Executable scripts only (no attributes), so the per-request JSON config block is excluded.
  const scriptOf = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)]
    .filter((m) => m[1].trim() === '')
    .map((m) => m[2]);
  const a = scriptOf((await render('?videoId=iEpJwprxDdk&autoplay=0&mute=1')).html);
  const b = scriptOf((await render('?videoId=gCNeDWCI0vo&autoplay=1&mute=0&vq=hd720&origin=http://127.0.0.1:46123&parentOrigin=https://tauri.localhost')).html);
  assert.equal(a.length, 1);
  assert.deepEqual(a, b);
});

test('passes playback quality through the config', async () => {
  assert.equal((await render('?videoId=iEpJwprxDdk&vq=hd720')).config.vq, 'hd720');
  assert.equal((await render('?videoId=iEpJwprxDdk&vq=bogus')).config.vq, '');
});

test('accepts custom origin parameter', async () => {
  const { config } = await render('?videoId=iEpJwprxDdk&origin=http://127.0.0.1:46123');
  assert.equal(config.origin, 'http://127.0.0.1:46123');
});

function withPreviewEnv(env, fn) {
  const keys = ['VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('a preview deployment trusts only its own Vercel hostnames', () => withPreviewEnv({
  VERCEL_ENV: 'preview',
  VERCEL_URL: 'worldmonitor-r6q9o-eliewm.vercel.app',
  VERCEL_BRANCH_URL: 'worldmonitor-git-feature-eliewm.vercel.app',
}, async () => {
  for (const own of ['https://worldmonitor-r6q9o-eliewm.vercel.app', 'https://worldmonitor-git-feature-eliewm.vercel.app']) {
    const query = new URLSearchParams({ videoId: 'iEpJwprxDdk', origin: own, parentOrigin: own });
    const { config } = await render(`?${query}`);
    assert.equal(config.origin, own);
    assert.equal(config.parentOrigin, own);
  }
  for (const foreign of [
    'https://worldmonitor-attacker-eliewm.vercel.app',
    'https://worldmonitor-git-feature-attacker.vercel.app',
  ]) {
    const query = new URLSearchParams({ videoId: 'iEpJwprxDdk', origin: foreign, parentOrigin: foreign });
    const { config } = await render(`?${query}`);
    assert.equal(config.origin, 'https://worldmonitor.app', foreign);
    assert.equal(config.parentOrigin, 'https://worldmonitor.app', foreign);
  }
}));

test('production trusts no Vercel preview origin, eliewm-shaped or not', () => withPreviewEnv({
  VERCEL_ENV: 'production',
  VERCEL_URL: 'worldmonitor-r6q9o-eliewm.vercel.app',
  VERCEL_BRANCH_URL: 'worldmonitor-git-main-eliewm.vercel.app',
}, async () => {
  for (const origin of [
    'https://worldmonitor-r6q9o-eliewm.vercel.app',
    'https://worldmonitor-git-main-eliewm.vercel.app',
    'https://worldmonitor-attacker-eliewm.vercel.app',
  ]) {
    const query = new URLSearchParams({ videoId: 'iEpJwprxDdk', origin, parentOrigin: origin });
    const { config } = await render(`?${query}`);
    assert.equal(config.origin, 'https://worldmonitor.app', origin);
    assert.equal(config.parentOrigin, 'https://worldmonitor.app', origin);
  }
}));

test('uses dedicated parentOrigin for iframe postMessage target', async () => {
  const { html, config } = await render('?videoId=iEpJwprxDdk&origin=https://worldmonitor.app&parentOrigin=https://tauri.localhost');
  assert.equal(config.origin, 'https://worldmonitor.app');
  assert.equal(config.parentOrigin, 'https://tauri.localhost');
  assert.match(html, /parentOrigin=config\.parentOrigin,allowedOrigin=config\.parentOrigin/);
  assert.match(html, /if\(allowedOrigin!==['"]\*['"]&&e\.origin!==allowedOrigin\)return/);
});

test('does not accept wildcard parentOrigin query parameter', async () => {
  const { config } = await render('?videoId=iEpJwprxDdk&origin=https://worldmonitor.app&parentOrigin=*');
  assert.equal(config.parentOrigin, 'https://worldmonitor.app');
});

test('preserves app and local origins for the player and parent', async () => {
  for (const origin of [
    ...TRUSTED_RETURN_URL_ORIGINS,
    'http://localhost:3000', 'https://localhost',
    'http://127.0.0.1:46123', 'https://127.0.0.1', 'tauri://localhost',
  ]) {
    const query = new URLSearchParams({ videoId: 'iEpJwprxDdk', origin, parentOrigin: origin });
    const { config } = await render(`?${query}`);
    assert.equal(config.origin, origin, origin);
    assert.equal(config.parentOrigin, origin, origin);
  }
});

test('rejects vendor, unknown, and look-alike origins for both player and parent', async () => {
  for (const origin of [
    'https://clerk.worldmonitor.app', 'https://abacus.worldmonitor.app',
    'https://anything-future.worldmonitor.app', 'https://nested.app.worldmonitor.app',
    'https://worldmonitor.app.evil.com', 'http://worldmonitor.app',
    'https://worldmonitor.app:8443', 'https://worldmonitor-foreign.vercel.app',
  ]) {
    const query = new URLSearchParams({ videoId: 'iEpJwprxDdk', origin, parentOrigin: origin });
    const { config } = await render(`?${query}`);
    assert.equal(config.origin, 'https://worldmonitor.app', origin);
    assert.equal(config.parentOrigin, 'https://worldmonitor.app', origin);

    query.set('origin', 'https://tech.worldmonitor.app');
    assert.equal((await render(`?${query}`)).config.parentOrigin, 'https://tech.worldmonitor.app', origin);
  }
});

test('preserves parent-only Tauri origins without accepting them as player origins', async () => {
  for (const origin of ['http://tauri.localhost', 'https://tauri.localhost', 'http://app.tauri.localhost', 'https://app.tauri.localhost']) {
    const query = new URLSearchParams({ videoId: 'iEpJwprxDdk', origin, parentOrigin: origin });
    const { config } = await render(`?${query}`);
    assert.equal(config.origin, 'https://worldmonitor.app', origin);
    assert.equal(config.parentOrigin, origin, origin);
  }
});
