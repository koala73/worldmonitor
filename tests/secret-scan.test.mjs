import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'secret-scan.mjs');

function runSecretScan(...args) {
  return spawnSync('node', [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('secret scan fails on committed credential-looking values', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'worldmonitor-secret-scan-'));
  const filePath = path.join(dir, 'leak.env');

  try {
    writeFileSync(filePath, 'OPENAI_API_KEY=prod-super-secret-key\n', 'utf8');

    const result = runSecretScan('--files', filePath);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /OPENAI_API_KEY/, 'scanner should report the leaked key name');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret scan allows placeholders and explicit waivers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'worldmonitor-secret-scan-'));
  const placeholderPath = path.join(dir, 'placeholder.env');
  const waivedPath = path.join(dir, 'waived.ts');

  try {
    writeFileSync(placeholderPath, 'OPENAI_API_KEY=your-openai-key-here\n', 'utf8');
    writeFileSync(
      waivedPath,
      'const fixture = "OPENAI_API_KEY=prod-super-secret-key"; // secret-scan: allow\n',
      'utf8',
    );

    const result = runSecretScan('--files', placeholderPath, waivedPath);

    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret scan fails on private key material', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'worldmonitor-secret-scan-'));
  const filePath = path.join(dir, 'private-key.pem');

  try {
    writeFileSync(
      filePath,
      '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n', // secret-scan: allow
      'utf8',
    );

    const result = runSecretScan('--files', filePath);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /PRIVATE KEY/, 'scanner should block private key material');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
