import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './embed.js';
import { TRUSTED_RETURN_URL_ORIGINS } from '../../convex/payments/returnUrlOrigin.ts';

function makeRequest(query = '') {
  return new Request(`https://worldmonitor.app/api/youtube/embed${query}`);
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

  const html = await response.text();
  assert.equal(html.includes("videoId:'iEpJwprxDdk'"), true);
  assert.equal(html.includes("host:'https://www.youtube.com'"), true);
  assert.equal(html.includes('autoplay:0'), true);
  assert.equal(html.includes('mute:1'), true);
  assert.equal(html.includes('origin:"https://worldmonitor.app"'), true);
  assert.equal(html.includes('postMessage'), true);
});

test('accepts custom origin parameter', async () => {
  const response = await handler(makeRequest('?videoId=iEpJwprxDdk&origin=http://127.0.0.1:46123'));
  const html = await response.text();
  assert.equal(html.includes('origin:"http://127.0.0.1:46123"'), true);
});

test('allows only team-pinned Vercel preview origins', async () => {
  const allowed = await handler(makeRequest(
    '?videoId=iEpJwprxDdk&origin=https://worldmonitor-git-feature-eliewm.vercel.app',
  ));
  assert.match(await allowed.text(), /origin:"https:\/\/worldmonitor-git-feature-eliewm\.vercel\.app"/);

  const foreign = await handler(makeRequest(
    '?videoId=iEpJwprxDdk&origin=https://worldmonitor-git-feature-attacker.vercel.app',
  ));
  assert.match(await foreign.text(), /origin:"https:\/\/worldmonitor\.app"/);
});

test('uses dedicated parentOrigin for iframe postMessage target', async () => {
  const response = await handler(makeRequest('?videoId=iEpJwprxDdk&origin=https://worldmonitor.app&parentOrigin=https://tauri.localhost'));
  const html = await response.text();
  assert.match(html, /playerVars:\{[^}]*origin:"https:\/\/worldmonitor\.app"/);
  assert.match(html, /parentOrigin="https:\/\/tauri\.localhost"/);
  assert.match(html, /if\(allowedOrigin!==['"]\*['"]&&e\.origin!==allowedOrigin\)return/);
});

test('does not accept wildcard parentOrigin query parameter', async () => {
  const response = await handler(makeRequest('?videoId=iEpJwprxDdk&origin=https://worldmonitor.app&parentOrigin=*'));
  const html = await response.text();
  assert.equal(html.includes('parentOrigin="*"'), false);
  assert.match(html, /parentOrigin="https:\/\/worldmonitor\.app"/);
});

test('preserves app, team preview, and local origins for the player and parent', async () => {
  for (const origin of [
    ...TRUSTED_RETURN_URL_ORIGINS,
    'https://worldmonitor-git-feature-eliewm.vercel.app',
    'http://localhost:3000', 'https://localhost',
    'http://127.0.0.1:46123', 'https://127.0.0.1', 'tauri://localhost',
  ]) {
    const query = new URLSearchParams({ videoId: 'iEpJwprxDdk', origin, parentOrigin: origin });
    const html = await (await handler(makeRequest(`?${query}`))).text();
    assert.ok(html.includes(`origin:${JSON.stringify(origin)}`), origin);
    assert.ok(html.includes(`parentOrigin=${JSON.stringify(origin)}`), origin);
    assert.ok(html.includes(`allowedOrigin=${JSON.stringify(origin)}`), origin);
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
    const html = await (await handler(makeRequest(`?${query}`))).text();
    assert.ok(html.includes('origin:"https://worldmonitor.app"'), origin);
    assert.ok(html.includes('parentOrigin="https://worldmonitor.app"'), origin);
    assert.ok(html.includes('allowedOrigin="https://worldmonitor.app"'), origin);

    query.set('origin', 'https://tech.worldmonitor.app');
    const withTrustedPlayer = await (await handler(makeRequest(`?${query}`))).text();
    assert.ok(withTrustedPlayer.includes('parentOrigin="https://tech.worldmonitor.app"'), origin);
  }
});

test('preserves parent-only Tauri origins without accepting them as player origins', async () => {
  for (const origin of ['http://tauri.localhost', 'https://tauri.localhost', 'http://app.tauri.localhost', 'https://app.tauri.localhost']) {
    const query = new URLSearchParams({ videoId: 'iEpJwprxDdk', origin, parentOrigin: origin });
    const html = await (await handler(makeRequest(`?${query}`))).text();
    assert.ok(html.includes('origin:"https://worldmonitor.app"'), origin);
    assert.ok(html.includes(`parentOrigin=${JSON.stringify(origin)}`), origin);
  }
});
