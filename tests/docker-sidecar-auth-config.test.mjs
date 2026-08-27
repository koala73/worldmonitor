import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
