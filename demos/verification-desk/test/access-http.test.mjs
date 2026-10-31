import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';

async function startDesk(t, env) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../server.mjs', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), DESK_HOST: '127.0.0.1', DESK_OFFLINE: '1', ANTHROPIC_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('Verification Desk on')) resolve(); });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Desk exited before readiness: ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

test('passwordless localhost desk still requires request intent on metered routes', { timeout: 15000 }, async t => {
  const base = await startDesk(t, { DESK_PASSWORD: '' });
  const denied = await fetch(`${base}/api/grade?headline=Untrusted`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(denied.status, 403);
  const sameOrigin = await fetch(`${base}/api/grade`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(sameOrigin.status, 400);
});

test('hosted metered routes check request intent after cookie authentication', { timeout: 15000 }, async t => {
  const base = await startDesk(t, { DESK_PASSWORD: 'test-desk-password' });
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body: 'password=test-desk-password' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, {}, { Origin: 'https://attacker.example' }]) {
    for (const route of ['/api/grade?headline=Untrusted', '/api/board?refresh=1', '/api/recap', '/api/reveal', '/api/avatar/token', '/api/tts']) {
      const denied = await fetch(`${base}${route}`, {
        method: ['/api/avatar/token', '/api/tts'].includes(route) ? 'POST' : 'GET',
        headers: { Cookie: cookie, ...headers },
      });
      assert.equal(denied.status, 403, route);
    }
  }
  const sameOrigin = await fetch(`${base}/api/grade`, { headers: { Cookie: cookie, Origin: base } });
  assert.equal(sameOrigin.status, 400);
  assert.equal((await sameOrigin.json()).error, 'headline required');
  const config = await fetch(`${base}/api/config`, { headers: { Cookie: cookie } });
  assert.equal(config.status, 200);
});
