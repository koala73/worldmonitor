import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

function readProjectFile(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

test('Docker entrypoint creates and exports an internal LOCAL_API_TOKEN when unset', () => {
  const entrypoint = readProjectFile('docker/entrypoint.sh');

  assert.match(entrypoint, /if \[ -z "\$\{LOCAL_API_TOKEN:-\}" \]; then/);
  assert.match(entrypoint, /randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(entrypoint, /export LOCAL_API_TOKEN/);
  assert.match(entrypoint, /envsubst '\$LOCAL_API_PORT \$LOCAL_API_TOKEN'/);
});

test('Docker nginx injects LOCAL_API_TOKEN on private sidecar proxy requests', () => {
  const nginx = readProjectFile('docker/nginx.conf');

  assert.match(nginx, /location \/api\/ \{/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:\$\{LOCAL_API_PORT\}/);
  assert.match(nginx, /proxy_set_header Authorization "Bearer \$\{LOCAL_API_TOKEN\}"/);
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
