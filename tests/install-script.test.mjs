// Drives scripts/install.sh with stub git/docker/node on PATH, so each case
// exercises the real shell logic without cloning, building, or seeding.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLER = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/install.sh');

const STUB_GIT = `#!/bin/sh
# git clone --depth 1 --branch B REPO DIR -> a minimal World Monitor checkout
if [ "$1" = clone ]; then
  for last; do :; done
  mkdir -p "$last/scripts"
  printf 'services:\\n  redis-rest:\\n    container_name: worldmonitor-redis-rest\\n' > "$last/docker-compose.yml"
  printf '{\\n  "name": "world-monitor"\\n}\\n' > "$last/package.json"
  printf '#!/bin/sh\\necho seeded >> "$STUB_LOG"\\n' > "$last/scripts/run-seeders.sh"
  echo "clone $last" >> "$STUB_LOG"
  exit 0
fi
exit 0
`;

const STUB_DOCKER = `#!/bin/sh
[ "$1 $2" = "compose version" ] && exit 0
echo "compose $* WM_PORT=\${WM_PORT:-} REDIS_TOKEN=\${REDIS_TOKEN:-}" >> "$STUB_LOG"
[ "$2" = pull ] && [ -n "\${STUB_PULL_FAIL:-}" ] && exit 1
exit 0
`;

const OLD_NODE = `#!/bin/sh
[ "$1" = -v ] && { echo v18.19.0; exit 0; }
exit 1
`;

let root;
let bin;
let log;

const writeExe = (path, body) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

const run = (args = [], { cwd = root, env = {}, stdin } = {}) => {
  const result = spawnSync('sh', stdin ? ['-s', '--', ...args] : [INSTALLER, ...args], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, STUB_LOG: log, ...env },
  });
  return { ...result, out: `${result.stdout}${result.stderr}` };
};

const envFile = (dir = join(root, 'worldmonitor')) => readFileSync(join(dir, '.env'), 'utf8');
const stubLog = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wm-install-'));
  bin = join(root, 'bin');
  log = join(root, 'stub.log');
  mkdirSync(bin);
  writeExe(join(bin, 'git'), STUB_GIT);
  writeExe(join(bin, 'docker'), STUB_DOCKER);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('scripts/install.sh', () => {
  it('clones, writes four secrets to an owner-only .env, and starts the stack', () => {
    const r = run(['--no-seed']);
    assert.equal(r.status, 0, r.out);
    const env = envFile();
    for (const key of ['RELAY_SHARED_SECRET', 'REDIS_PASSWORD', 'REDIS_TOKEN', 'WM_SESSION_SECRET']) {
      assert.match(env, new RegExp(`^${key}=[0-9a-f]{64}$`, 'm'), key);
    }
    assert.equal(statSync(join(root, 'worldmonitor', '.env')).mode & 0o777, 0o600);
    assert.match(stubLog(), /compose pull [^\n]*\ncompose compose up -d WM_PORT=3000 /);
    assert.doesNotMatch(stubLog(), /--build/);
    assert.match(r.out, /http:\/\/localhost:3000/);
  });

  it('builds from source with --build and does not pull', () => {
    const r = run(['--no-seed', '--build']);
    assert.equal(r.status, 0, r.out);
    assert.match(stubLog(), /compose up -d --build WM_PORT=3000 /);
    assert.doesNotMatch(stubLog(), /compose pull/);
  });

  it('falls back to building from source when the pull fails', () => {
    const r = run(['--no-seed'], { env: { STUB_PULL_FAIL: '1' } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /building from source instead/);
    assert.match(stubLog(), /compose pull [^\n]*\ncompose compose up -d --build WM_PORT=3000 /);
  });

  it('--no-build neither pulls nor builds', () => {
    const r = run(['--no-seed', '--no-build']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(stubLog(), /compose pull|--build/);
    assert.match(stubLog(), /compose up -d WM_PORT=3000 /);
  });

  it('keeps secrets on a re-run and tightens a world-readable .env', () => {
    assert.equal(run(['--no-seed']).status, 0);
    const before = envFile();
    chmodSync(join(root, 'worldmonitor', '.env'), 0o644);
    const r = run(['--no-seed', '--no-build']);
    assert.equal(r.status, 0, r.out);
    assert.equal(envFile(), before);
    assert.equal(statSync(join(root, 'worldmonitor', '.env')).mode & 0o777, 0o600);
  });

  it('uses the saved port on a re-run without --port', () => {
    assert.equal(run(['--no-seed', '--port', '8080']).status, 0);
    const r = run(['--no-seed']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /http:\/\/localhost:8080/);
    assert.doesNotMatch(r.out, /localhost:3000/);
    assert.match(stubLog().trim().split('\n').at(-1), /WM_PORT=8080 /);
  });

  it('rejects out-of-range ports', () => {
    for (const port of ['0', '65536', '70000', 'abc']) {
      assert.notEqual(run(['--no-seed', '--port', port]).status, 0, port);
    }
  });

  it('replaces quoted empty placeholders and never joins a line without a trailing newline', () => {
    const dir = join(root, 'worldmonitor');
    run(['--no-seed']);
    writeFileSync(join(dir, '.env'), 'REDIS_TOKEN=""\nWM_SESSION_SECRET=\'\'\nFOO=bar');
    const r = run(['--no-seed']);
    assert.equal(r.status, 0, r.out);
    const env = envFile();
    assert.match(env, /^FOO=bar$/m);
    assert.equal(env.match(/^REDIS_TOKEN=/gm).length, 1);
    assert.equal(env.match(/^WM_SESSION_SECRET=/gm).length, 1);
    assert.match(env, /^REDIS_TOKEN=[0-9a-f]{64}$/m);
    assert.match(env, /^WM_SESSION_SECRET=[0-9a-f]{64}$/m);
  });

  it('writes an exported token single-quoted so $ stays literal', () => {
    const r = run(['--no-seed'], { env: { REDIS_TOKEN: 'tok$HOME#x' } });
    assert.equal(r.status, 0, r.out);
    assert.match(envFile(), /^REDIS_TOKEN='tok\$HOME#x'$/m);
  });

  it('gives Compose the .env token when an exported one differs, matching run-seeders.sh', () => {
    assert.equal(run(['--no-seed']).status, 0);
    const saved = envFile().match(/^REDIS_TOKEN=(.*)$/m)[1];
    const r = run(['--no-seed'], { env: { REDIS_TOKEN: 'other' } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /exported REDIS_TOKEN differs from \.env/);
    assert.match(stubLog().trim().split('\n').at(-1), new RegExp(`REDIS_TOKEN=${saved}$`));
  });

  it('does not treat another Compose project in cwd as a checkout', () => {
    const other = join(root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n');
    writeFileSync(join(other, '.env'), 'APP=1\n');
    const r = run(['--no-seed'], { cwd: other });
    assert.equal(r.status, 0, r.out);
    assert.equal(readFileSync(join(other, '.env'), 'utf8'), 'APP=1\n');
    assert.ok(existsSync(join(other, 'worldmonitor', '.env')));
  });

  it('refuses a non-empty --dir that is not a checkout', () => {
    const dir = join(root, 'busy');
    mkdirSync(dir);
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const r = run(['--no-seed', '--dir', dir]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /is not a World Monitor checkout/);
    assert.ok(!existsSync(join(dir, '.env')));
  });

  it('prints the full help when piped', () => {
    const r = run(['--help'], { stdin: readFileSync(INSTALLER, 'utf8') });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /--port PORT/);
    assert.match(r.stdout, /bash -s -- \[options\]/);
  });

  it('installs node_modules and waits for the proxy before seeding', () => {
    writeExe(join(bin, 'node'), '#!/bin/sh\nexit 0\n');
    writeExe(join(bin, 'npm'), '#!/bin/sh\necho "npm $*" >> "$STUB_LOG"\nmkdir node_modules\n');
    writeExe(join(bin, 'curl'), '#!/bin/sh\necho "curl" >> "$STUB_LOG"\nprintf 401\n');
    const r = run([]);
    assert.equal(r.status, 0, r.out);
    const steps = stubLog().split('\n').filter((l) => /^(npm|curl|seeded)/.test(l));
    assert.deepEqual(steps, ['npm ci', 'curl', 'seeded']);
  });

  it('skips seeding on Node older than 22.19 instead of failing mid-seed', () => {
    writeExe(join(bin, 'node'), OLD_NODE);
    const r = run([]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /v18\.19\.0 is older than 22\.19, skipping seed step/);
    assert.doesNotMatch(stubLog(), /seeded/);
  });
});
