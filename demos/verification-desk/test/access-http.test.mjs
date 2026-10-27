import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';

test('the hosted grade route checks request intent after cookie authentication', { timeout: 15000 }, async t => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../server.mjs', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), DESK_HOST: '127.0.0.1', DESK_PASSWORD: 'test-desk-password', DESK_OFFLINE: '1', ANTHROPIC_API_KEY: '' },
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
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body: 'password=test-desk-password' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, {}, { Origin: 'https://attacker.example' }]) {
    const denied = await fetch(`${base}/api/grade?headline=Untrusted`, { headers: { Cookie: cookie, ...headers } });
    assert.equal(denied.status, 403);
  }
  const sameOrigin = await fetch(`${base}/api/grade`, { headers: { Cookie: cookie, Origin: base } });
  assert.equal(sameOrigin.status, 400);
  assert.equal((await sameOrigin.json()).error, 'headline required');
});
