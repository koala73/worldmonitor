import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const script = readFileSync(new URL('../scripts/download-node.sh', import.meta.url), 'utf8');
const archive = 'node-v22.23.4-linux-x64.tar.gz';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
let fixture;
let keyHome;
let trustedKeyring;
let checksum;
let signature;
let foreignSignature;

function gpg(args) {
  return execFileSync('gpg', ['--batch', '--homedir', keyHome, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

before(() => {
  fixture = mkdtempSync(join(tmpdir(), 'wm-node-'));
  keyHome = join(fixture, 'gpg');
  mkdirSync(keyHome, { mode: 0o700 });
  for (const name of ['trusted', 'foreign']) {
    gpg(['--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', `${name}@example.test`, 'ed25519', 'sign', '0']);
  }
  trustedKeyring = gpg(['--export', 'trusted@example.test']);
  const payload = join(fixture, 'node-v22.23.4-linux-x64');
  mkdirSync(join(payload, 'bin'), { recursive: true });
  writeFileSync(join(payload, 'bin/node'), '#!/bin/sh\necho fixture-node\n', { mode: 0o755 });
  writeFileSync(join(payload, 'LICENSE'), 'Fixture license\n');
  execFileSync('tar', ['-czf', join(fixture, archive), '-C', fixture, 'node-v22.23.4-linux-x64']);
  checksum = `${sha256(readFileSync(join(fixture, archive)))}  ${archive}\n`;
  const sums = join(fixture, 'sums');
  writeFileSync(sums, checksum);
  signature = gpg(['--pinentry-mode', 'loopback', '--passphrase', '', '--local-user', 'trusted@example.test', '--detach-sign', '--output', '-', sums]);
  foreignSignature = gpg(['--pinentry-mode', 'loopback', '--passphrase', '', '--local-user', 'foreign@example.test', '--detach-sign', '--output', '-', sums]);
});

after(() => {
  if (keyHome) spawnSync('gpgconf', ['--homedir', keyHome, '--kill', 'gpg-agent']);
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

function runDownload({ sums = checksum, sig = signature, keys = trustedKeyring, corruptArchive = false } = {}) {
  const dir = mkdtempSync(join(fixture, 'case-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'downloads'));
  const pinnedScript = script.replace(/NODE_RELEASE_KEYS_SHA256="[a-f0-9]{64}"/, `NODE_RELEASE_KEYS_SHA256="${sha256(trustedKeyring)}"`);
  writeFileSync(join(dir, 'scripts/download-node.sh'), pinnedScript);
  copyFileSync(join(fixture, archive), join(dir, 'downloads', archive));
  if (corruptArchive) writeFileSync(join(dir, 'downloads', archive), 'tampered archive');
  writeFileSync(join(dir, 'downloads/SHASUMS256.txt'), sums);
  if (sig !== null) writeFileSync(join(dir, 'downloads/SHASUMS256.txt.sig'), sig);
  writeFileSync(join(dir, 'downloads/pubring.kbx'), keys);
  writeFileSync(join(dir, 'bin/curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith('https://'));
fs.appendFileSync(process.env.DOWNLOAD_LOG, url + '\\n');
fs.copyFileSync(path.join(process.env.DOWNLOAD_FIXTURE, path.basename(url)), args[args.indexOf('-o') + 1]);
`, { mode: 0o755 });
  const dest = join(dir, 'src-tauri/sidecar/node/node');
  mkdirSync(join(dir, 'src-tauri/sidecar/node'), { recursive: true });
  writeFileSync(dest, 'previous node');
  const result = spawnSync('bash', [join(dir, 'scripts/download-node.sh'), '--target', 'x86_64-unknown-linux-gnu'], {
    encoding: 'utf8',
    env: { ...process.env, GNUPGHOME: keyHome, NODE_VERSION: '22.23.4', PATH: `${join(dir, 'bin')}:${process.env.PATH}`, DOWNLOAD_FIXTURE: join(dir, 'downloads'), DOWNLOAD_LOG: join(dir, 'requests.log') },
  });
  return { ...result, dest, requests: readFileSync(join(dir, 'requests.log'), 'utf8') };
}

test('installs an archive only after its pinned keyring, signature and checksum pass', () => {
  const result = runDownload();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.requests, /SHASUMS256\.txt\.sig/);
  assert.match(result.requests, /raw\.githubusercontent\.com\/nodejs\/release-keys\/[a-f0-9]{40}\/gpg-only-active-keys\/pubring\.kbx/);
  assert.equal(execFileSync(result.dest, { encoding: 'utf8' }).trim(), 'fixture-node');
  assert.ok(existsSync(join(result.dest, '../LICENSE')));
});

for (const [name, options, error] of [
  ['missing signature', () => ({ sig: null }), /SHASUMS256\.txt\.sig/],
  ['a substituted archive and matching checksums', () => ({ corruptArchive: true, sums: `${sha256('tampered archive')}  ${archive}\n` }), /BAD signature/],
  ['unknown signing key', () => ({ sig: foreignSignature }), /No public key/],
  ['substituted release keyring', () => ({ keys: Buffer.from('untrusted keyring') }), /Release keyring checksum mismatch/],
  ['corrupt archive', () => ({ corruptArchive: true }), /Checksum mismatch/],
]) {
  test(`rejects ${name} and preserves the installed runtime`, () => {
    const result = runDownload(options());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(readFileSync(result.dest, 'utf8'), 'previous node');
  });
}
