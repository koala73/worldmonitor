// The Tauri bundler downloads its AppImage tools with no retry, so one GitHub
// 504 failed the Desktop Canary (run 42567226797). scripts/prefetch-appimage-
// tools.sh fills the bundler's tool directory first, through
// scripts/fetch-with-retry.sh. These run both scripts against stub `curl` and
// `sleep` commands so retries and backoff are exercised without the network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FETCH = join(root, 'scripts/fetch-with-retry.sh');
const PREFETCH = join(root, 'scripts/prefetch-appimage-tools.sh');

// curl stub: fails the first FAKE_CURL_FAILS calls, and every call whose URL
// contains FAKE_CURL_FAIL_MATCH; otherwise writes the URL to --output.
const FAKE_CURL = `#!/usr/bin/env bash
out=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
echo "$url" >> "$FAKE_LOG_DIR/curl.log"
n=$(wc -l < "$FAKE_LOG_DIR/curl.log")
if [ "$n" -le "\${FAKE_CURL_FAILS:-0}" ]; then
  echo "curl: (22) The requested URL returned error: 504" >&2; exit 22
fi
if [ -n "\${FAKE_CURL_FAIL_MATCH:-}" ] && [[ "$url" == *"$FAKE_CURL_FAIL_MATCH"* ]]; then
  echo "curl: (22) The requested URL returned error: 504" >&2; exit 22
fi
printf 'payload:%s' "$url" > "$out"
`;
const FAKE_SLEEP = `#!/usr/bin/env bash
echo "$1" >> "$FAKE_LOG_DIR/sleep.log"
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'wm-appimage-prefetch-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  writeFileSync(join(bin, 'sleep'), FAKE_SLEEP);
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  const run = (script, args, env = {}) =>
    spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_LOG_DIR: dir,
        XDG_CACHE_HOME: join(dir, 'cache'),
        ...env,
      },
    });
  const lines = (name) => {
    const file = join(dir, name);
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
  };
  return { dir, run, lines };
}

describe('fetch-with-retry.sh', () => {
  it('waits out transient failures and writes the file once', () => {
    const { dir, run, lines } = sandbox();
    const dest = join(dir, 'out', 'tool');
    const result = run(FETCH, ['https://example.test/tool', dest], { FAKE_CURL_FAILS: '2' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(dest, 'utf8'), 'payload:https://example.test/tool');
    assert.deepEqual(lines('sleep.log'), ['10', '20']);
    assert.equal(lines('curl.log').length, 3);
    assert.deepEqual(readdirSync(join(dir, 'out')), ['tool'], 'no partial file may remain');
  });

  it('fails after the retry budget and leaves no file behind', () => {
    const { dir, run, lines } = sandbox();
    const dest = join(dir, 'out', 'tool');
    const result = run(FETCH, ['https://example.test/tool', dest], { FAKE_CURL_FAILS: '99' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Download failed after 7 attempts/);
    assert.deepEqual(lines('sleep.log'), ['10', '20', '40', '60', '90', '120']);
    assert.deepEqual(readdirSync(join(dir, 'out')), [], 'a failed download must not leave a file the bundler would trust');
  });
});

describe('prefetch-appimage-tools.sh', () => {
  const TOOLS = [
    'AppRun-x86_64',
    'linuxdeploy-plugin-appimage.AppImage',
    'linuxdeploy-plugin-gstreamer.sh',
    'linuxdeploy-plugin-gtk.sh',
    'linuxdeploy-x86_64.AppImage',
  ];

  it('fills the bundler tool directory with executable tools, then reuses them', () => {
    const { dir, run, lines } = sandbox();
    const toolsDir = join(dir, 'cache', 'tauri');
    const first = run(PREFETCH, ['x86_64']);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(readdirSync(toolsDir).sort(), TOOLS);
    for (const name of TOOLS) {
      assert.ok(statSync(join(toolsDir, name)).mode & 0o100, `${name} must be executable`);
    }
    assert.match(
      readFileSync(join(toolsDir, 'AppRun-x86_64'), 'utf8'),
      /releases\/download\/apprun-old\/AppRun-x86_64$/,
    );
    assert.equal(lines('curl.log').length, TOOLS.length);

    const second = run(PREFETCH, ['x86_64']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(lines('curl.log').length, TOOLS.length, 'cached tools must not be downloaded again');
  });

  it('tolerates the optional appimage plugin being unavailable', () => {
    const { dir, run } = sandbox();
    const result = run(PREFETCH, ['x86_64'], { FAKE_CURL_FAIL_MATCH: 'linuxdeploy-plugin-appimage' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /falls back to its built-in version/);
    assert.ok(!existsSync(join(dir, 'cache', 'tauri', 'linuxdeploy-plugin-appimage.AppImage')));
  });

  it('fails when a required tool cannot be downloaded', () => {
    const { run } = sandbox();
    const result = run(PREFETCH, ['x86_64'], { FAKE_CURL_FAIL_MATCH: 'apprun-old' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Download failed after 7 attempts: .*apprun-old/);
  });

  it('rejects an unsupported architecture', () => {
    const { run } = sandbox();
    assert.equal(run(PREFETCH, ['riscv64']).status, 2);
  });
});
