import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const root = resolve(import.meta.dirname, '..');
const routes = ['/api/data', '/api/oauth/authorize', '/api/oauth/authorize-pro', '/api/youtube/embed'];

test('frontend nginx rejects untrusted and wrong-host TLS upstreams before forwarding credentials', {
  skip: !process.env.WM_TEST_NGINX,
  timeout: 30_000,
}, async (t) => {
  const dir = createTempDir('worldmonitor-nginx-tls-');
  mkdirSync(join(dir, 'logs'));
  function certificate(name) {
    const cert = join(dir, `${name}.crt`);
    const key = join(dir, `${name}.key`);
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
      '-keyout', key, '-out', cert,
    ], { stdio: 'ignore' });
    return { cert: readFileSync(cert), key: readFileSync(key), path: cert };
  }

  try {
    const trusted = certificate('trusted');
    const untrusted = certificate('untrusted');
    for (const scenario of ['trusted', 'untrusted', 'wrong-host']) await t.test(scenario, async () => {
      const hits = [];
      const upstream = createHttpsServer(scenario === 'untrusted' ? untrusted : trusted, (req, res) => {
        hits.push({ path: req.url, sni: req.socket.servername });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          authorization: req.headers.authorization,
          apiKey: req.headers['x-worldmonitor-key'],
          cookie: req.headers.cookie,
        }));
      });
      upstream.listen(0);
      await once(upstream, 'listening');
      let nginx;
      let stopped;
      try {
        const reservation = createServer();
        reservation.listen(0, '127.0.0.1');
        await once(reservation, 'listening');
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        const host = scenario === 'wrong-host' ? '127.0.0.1' : 'localhost';
        let config = readFileSync(join(root, 'docker/nginx.conf.template'), 'utf8')
          .replace('worker_processes auto;', 'worker_processes 1;')
          .replace('listen 80;', `listen 127.0.0.1:${port};`)
          .replaceAll('${API_UPSTREAM}', `https://${host}:${upstream.address().port}`)
          .replace('include       /etc/nginx/mime.types;', 'types {}')
          .replace('/etc/ssl/certs/ca-certificates.crt', trusted.path)
          .replaceAll('/usr/share/nginx/html', dir);
        for (const name of ['security', 'embed_security', 'oauth_authorize_security', 'youtube_embed_security']) {
          config = config.replaceAll(`/etc/nginx/${name}_headers.conf`,
            join(root, `docker/nginx-${name.replaceAll('_', '-')}-headers.conf`));
        }
        const configPath = join(dir, 'nginx.conf');
        writeFileSync(configPath, `pid ${dir}/nginx.pid;\nerror_log ${dir}/logs/error.log;\n${config}`);
        const check = spawnSync(process.env.WM_TEST_NGINX, ['-t', '-p', `${dir}/`, '-c', configPath], { encoding: 'utf8' });
        assert.equal(check.status, 0, check.stderr);
        nginx = spawn(process.env.WM_TEST_NGINX, ['-p', `${dir}/`, '-c', configPath, '-g', 'daemon off;'], { stdio: 'ignore' });
        stopped = once(nginx, 'exit');
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
            ready = true;
            break;
          } catch {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
        assert.ok(ready, 'nginx must start');
        for (const route of routes) {
          const response = await fetch(`http://127.0.0.1:${port}${route}`, {
            headers: { Authorization: 'Bearer synthetic-token', 'X-WorldMonitor-Key': 'synthetic-key', Cookie: 'session=synthetic-cookie' },
            signal: AbortSignal.timeout(3000),
          });
          assert.equal(response.status, scenario === 'trusted' ? 200 : 502, `${scenario} ${route}`);
          if (scenario === 'trusted') assert.deepEqual(await response.json(), {
            authorization: 'Bearer synthetic-token', apiKey: 'synthetic-key', cookie: 'session=synthetic-cookie',
          });
          else await response.text();
        }
        assert.deepEqual(hits, scenario === 'trusted'
          ? routes.map(path => ({ path, sni: 'localhost' })) : []);
      } finally {
        if (nginx) {
          nginx.kill('SIGQUIT');
          await stopped;
        }
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
      }
    });
  } finally {
    removeTempDir(dir);
  }
});
