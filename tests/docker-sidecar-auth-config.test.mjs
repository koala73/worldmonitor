import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const root = resolve(import.meta.dirname, '..');

function readProjectFile(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function runRealIpRenderer(value) {
  const tempDir = createTempDir('worldmonitor-realip-');
  const outputPath = resolve(tempDir, 'nginx-realip.conf');
  const env = { ...process.env };

  if (value === undefined) {
    delete env.WM_TRUSTED_PROXY_CIDRS;
  } else {
    env.WM_TRUSTED_PROXY_CIDRS = value;
  }

  const result = spawnSync(
    process.execPath,
    [resolve(root, 'docker/render-nginx-realip.mjs'), outputPath],
    { encoding: 'utf8', env },
  );

  return {
    ...result,
    outputPath,
    cleanup: () => removeTempDir(tempDir),
  };
}

function runSessionSecretValidator(value) {
  const env = { ...process.env };

  if (value === undefined) {
    delete env.WM_SESSION_SECRET;
  } else {
    env.WM_SESSION_SECRET = value;
  }

  return spawnSync(
    process.execPath,
    [resolve(root, 'docker/validate-session-secret.mjs')],
    { encoding: 'utf8', env },
  );
}

test('Docker entrypoint creates and exports an internal LOCAL_API_TOKEN when unset', () => {
  const entrypoint = readProjectFile('docker/entrypoint.sh');

  assert.match(entrypoint, /if \[ -z "\$\{LOCAL_API_TOKEN:-\}" \]; then/);
  assert.match(entrypoint, /randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(entrypoint, /export LOCAL_API_TOKEN/);
  assert.match(entrypoint, /envsubst '\$LOCAL_API_PORT \$LOCAL_API_TOKEN'/);
});

test('Docker nginx injects LOCAL_API_TOKEN through a private transport header', () => {
  const nginx = readProjectFile('docker/nginx.conf');

  assert.match(nginx, /location \/api\/ \{/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:\$\{LOCAL_API_PORT\}/);
  assert.match(nginx, /proxy_set_header X-WorldMonitor-Local-Token "\$\{LOCAL_API_TOKEN\}"/);
  assert.doesNotMatch(nginx, /proxy_set_header Authorization/);
});

test('Docker nginx applies an inert response policy to the RSS proxy route', () => {
  const nginx = readProjectFile('docker/nginx.conf');
  const rssBlock = nginx.match(/location = \/api\/rss-proxy \{[\s\S]*?\n    \}/)?.[0] ?? '';

  assert.ok(rssBlock, 'RSS proxy must have a dedicated Docker location');
  assert.match(rssBlock, /add_header X-Content-Type-Options "nosniff" always;/);
  assert.match(rssBlock, /add_header Content-Security-Policy "sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" always;/);
  assert.match(rssBlock, /proxy_pass http:\/\/127\.0\.0\.1:\$\{LOCAL_API_PORT\};/);
  assert.match(rssBlock, /proxy_set_header X-WorldMonitor-Local-Token "\$\{LOCAL_API_TOKEN\}";/);
  assert.match(rssBlock, /proxy_read_timeout 120s;/);
  assert.match(rssBlock, /proxy_send_timeout 120s;/);
});

test('Docker nginx denies the native administration namespace before the data proxy', () => {
  const nginx = readProjectFile('docker/nginx.conf');
  assert.match(nginx, /location \^~ \/api\/local- \{\s*add_header Origin-Agent-Cluster "\?1" always;\s*return 403;/);
  const staticNginx = readProjectFile('docker/nginx.conf.template');
  assert.doesNotMatch(staticNginx, /LOCAL_API_TOKEN|X-WorldMonitor-Local-Token/);
  assert.match(staticNginx, /proxy_pass \$\{API_UPSTREAM\}/);
});

// Opt in where nginx is installed: WM_TEST_NGINX=/usr/sbin/nginx node --test ...
test('shipped nginx configurations separate native management from Docker data APIs', {
  skip: !process.env.WM_TEST_NGINX,
}, async () => {
  const browserFetch = globalThis.fetch;
  const { createLocalApiServer } = await import('../src-tauri/sidecar/local-api-server.mjs');
  const tempDir = createTempDir('worldmonitor-nginx-admin-');
  const token = 'synthetic-ingress-token';
  const originalToken = process.env.LOCAL_API_TOKEN;
  const originalRelay = process.env.WS_RELAY_URL;
  process.env.LOCAL_API_TOKEN = token;
  process.env.WS_RELAY_URL = 'https://operator-relay.example';
  const apiDir = join(tempDir, 'api');
  mkdirSync(apiDir);
  mkdirSync(join(tempDir, 'logs'));
  writeFileSync(join(apiDir, 'data.js'), `export default req => Response.json({
    authorization: req.headers.get('authorization'),
    transport: req.headers.get('x-worldmonitor-local-token')
  });`);
  const sidecar = await createLocalApiServer({
    port: 0, apiDir, dataDir: tempDir, mode: 'docker',
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port: sidecarPort } = await sidecar.start();
  const upstreamHits = [];
  const upstream = createServer((req, res) => {
    upstreamHits.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ authorization: req.headers.authorization, transport: req.headers['x-worldmonitor-local-token'] ?? null }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  try {
    for (const topology of ['full', 'static']) {
      // Only ports and container filesystem paths change; nginx executes the shipped routing rules.
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      let config = readProjectFile(topology === 'full' ? 'docker/nginx.conf' : 'docker/nginx.conf.template')
        .replace(/listen (?:8080|80);/, `listen 127.0.0.1:${port};`)
        .replaceAll('${LOCAL_API_PORT}', String(sidecarPort))
        .replaceAll('${LOCAL_API_TOKEN}', token)
        .replaceAll('${API_UPSTREAM}', `http://127.0.0.1:${upstream.address().port}`)
        .replaceAll('/usr/share/nginx/html', tempDir)
        .replaceAll('/etc/nginx/security_headers.conf', resolve(root, 'docker/nginx-security-headers.conf'))
        .replaceAll('/etc/nginx/embed_security_headers.conf', resolve(root, 'docker/nginx-embed-security-headers.conf'))
        .replaceAll('/dev/stderr', join(tempDir, 'logs/error.log'))
        .replaceAll('/dev/stdout', join(tempDir, 'logs/access.log'))
        .replaceAll('/tmp/nginx', join(tempDir, 'nginx'));
      if (topology === 'static') config = `pid ${tempDir}/nginx.pid;\n${config}`;
      writeFileSync(join(tempDir, 'nginx-realip.conf'), '');
      const configPath = join(tempDir, 'nginx.conf');
      writeFileSync(configPath, config);
      const check = spawnSync(process.env.WM_TEST_NGINX, ['-t', '-p', `${tempDir}/`, '-c', configPath], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr);
      const nginx = spawn(process.env.WM_TEST_NGINX, ['-p', `${tempDir}/`, '-c', configPath, '-g', 'daemon off;'], { stdio: 'ignore' });
      const stopped = once(nginx, 'exit');
      const base = `http://127.0.0.1:${port}`;
      try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try { await browserFetch(`${base}/api/data`); ready = true; break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(ready, `${topology} nginx must start: ${readFileSync(join(tempDir, 'logs/error.log'), 'utf8')}`);
        const data = await browserFetch(`${base}/api/data`, { headers: { Authorization: 'Bearer caller-oauth' } });
        assert.equal(data.status, 200);
        assert.deepEqual(await data.json(), { authorization: 'Bearer caller-oauth', transport: null });
        if (topology === 'static') {
          assert.ok(upstreamHits.includes('/api/data'), 'static image forwards data to its configured upstream');
          continue;
        }
        for (const route of ['local-env-update', 'local-env-update-batch', 'local-validate-secret', 'local-status', 'local-traffic-log', 'local-debug-toggle']) {
          for (const headers of [{}, { Origin: 'https://tauri.localhost', Authorization: `Bearer ${token}`, 'X-WorldMonitor-Local-Token': token }]) {
            const response = await browserFetch(`${base}/api/${route}`, {
              method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: 'WS_RELAY_URL', value: 'https://untrusted-relay.example', entries: [{ key: 'WS_RELAY_URL', value: 'https://untrusted-relay.example' }] }),
            });
            assert.equal(response.status, 403, route);
            assert.match(await response.text(), /nginx/i, 'nginx itself must deny management before proxying');
          }
        }
        assert.equal(process.env.WS_RELAY_URL, 'https://operator-relay.example');
        assert.equal((await browserFetch(`${base}/api/sidecar-health`)).status, 200);
      } finally {
        nginx.kill('SIGQUIT');
        await stopped;
      }
    }
  } finally {
    await sidecar.close();
    await new Promise(resolve => upstream.close(resolve));
    if (originalToken === undefined) delete process.env.LOCAL_API_TOKEN;
    else process.env.LOCAL_API_TOKEN = originalToken;
    if (originalRelay === undefined) delete process.env.WS_RELAY_URL;
    else process.env.WS_RELAY_URL = originalRelay;
    removeTempDir(tempDir);
  }
});

test('Docker nginx overwrites X-Real-IP from the TCP peer on /api/', () => {
  const nginx = readProjectFile('docker/nginx.conf');
  const dockerfile = readProjectFile('Dockerfile');
  const entrypoint = readProjectFile('docker/entrypoint.sh');
  const apiBlock = nginx.match(/location \/api\/ \{[\s\S]*?\n {4}\}/)?.[0] ?? '';

  assert.match(nginx, /include\s+\/tmp\/nginx-realip\.conf;/);
  assert.match(apiBlock, /proxy_set_header X-Real-IP \$remote_addr;/);
  // The sidecar image copies this file, not docker/nginx.conf.template.
  // A stamp that never reaches the container does not bind Docker LLM quota.
  assert.match(dockerfile, /COPY docker\/nginx\.conf \/etc\/nginx\/nginx\.conf\.template/);
  assert.match(dockerfile, /COPY docker\/render-nginx-realip\.mjs \/app\/render-nginx-realip\.mjs/);
  assert.match(entrypoint, /node \/app\/render-nginx-realip\.mjs/);
});

test('trusted proxy configuration is opt-in and preserves the direct peer by default', () => {
  const result = runRealIpRenderer(undefined);

  try {
    assert.equal(result.status, 0, result.stderr);
    const config = readFileSync(result.outputPath, 'utf8');
    assert.doesNotMatch(config, /set_real_ip_from|real_ip_header|real_ip_recursive/);
  } finally {
    result.cleanup();
  }
});

test('trusted proxy configuration accepts explicit IPv4 and IPv6 networks', () => {
  const result = runRealIpRenderer('10.0.0.0/8, 2001:db8::/32');

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(result.outputPath, 'utf8'),
      [
        'set_real_ip_from 10.0.0.0/8;',
        'set_real_ip_from 2001:db8::/32;',
        'real_ip_header X-Forwarded-For;',
        'real_ip_recursive on;',
        '',
      ].join('\n'),
    );
  } finally {
    result.cleanup();
  }
});

test('trusted proxy configuration rejects invalid or injectable values', () => {
  for (const value of ['10.0.0.0/99', 'proxy.internal', '10.0.0.0/8; include /etc/passwd']) {
    const result = runRealIpRenderer(value);

    try {
      assert.notEqual(result.status, 0, value);
      assert.match(result.stderr, /Invalid IP or CIDR in WM_TRUSTED_PROXY_CIDRS/);
      assert.equal(existsSync(result.outputPath), false);
    } finally {
      result.cleanup();
    }
  }
});

test('Docker compose forwards WM_SESSION_SECRET to the API container', () => {
  const compose = readProjectFile('docker-compose.yml');

  assert.match(compose, /WM_SESSION_SECRET: "\$\{WM_SESSION_SECRET:\?[^}]+\}"/);
});

test('Docker startup validates WM_SESSION_SECRET before starting services', () => {
  const dockerfile = readProjectFile('Dockerfile');
  const entrypoint = readProjectFile('docker/entrypoint.sh');

  assert.match(
    dockerfile,
    /COPY docker\/validate-session-secret\.mjs \/app\/validate-session-secret\.mjs/,
  );
  assert.match(entrypoint, /node \/app\/validate-session-secret\.mjs/);

  for (const value of [undefined, '', 'x'.repeat(31)]) {
    const result = runSessionSecretValidator(value);
    assert.notEqual(result.status, 0, value ?? 'unset');
    assert.match(result.stderr, /WM_SESSION_SECRET must be at least 32 characters/);
  }

  const valid = runSessionSecretValidator('x'.repeat(32));
  assert.equal(valid.status, 0, valid.stderr);
});

test('Docker compose forwards optional trusted proxy CIDRs to the API container', () => {
  const compose = readProjectFile('docker-compose.yml');

  assert.match(compose, /WM_TRUSTED_PROXY_CIDRS: "\$\{WM_TRUSTED_PROXY_CIDRS:-\}"/);
});

test('Docker healthcheck uses the dedicated sidecar liveness route', () => {
  const dockerfile = readProjectFile('Dockerfile');

  assert.match(dockerfile, /HEALTHCHECK[\s\S]*wget -qO- http:\/\/127\.0\.0\.1:8080\/api\/sidecar-health/);
  assert.doesNotMatch(dockerfile, /HEALTHCHECK[\s\S]*wget -qO- http:\/\/(?:localhost|127\.0\.0\.1):8080\/api\/health(?:\s|$)/);
});

test('Relay healthcheck probes 127.0.0.1 (not localhost) so the IPv4 bind is reachable', () => {
  const dockerfile = readProjectFile('Dockerfile.relay');

  // localhost resolves to ::1 first, but the relay binds IPv4 (or dual-stack
  // without an IPv6 loopback), so a localhost probe gets "connection refused".
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*wget -qO- http:\/\/127\.0\.0\.1:3004\/health/);
  assert.doesNotMatch(dockerfile, /HEALTHCHECK[\s\S]*wget -qO- http:\/\/localhost:3004\/health/);
});
