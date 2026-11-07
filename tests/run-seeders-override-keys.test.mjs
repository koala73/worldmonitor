// run-seeders.sh exports seeder API keys from docker-compose.override.yml.
// Override files usually carry a trailing `# comment` on key lines (earlier
// SELF_HOSTING.md templates put one on every key), so the parser must keep
// those lines and strip the comment, and it must run under BSD sed (macOS),
// which has no `\s`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;

function runWithOverride(overrideYaml) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-run-seeders-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(join(repoRoot, 'scripts/run-seeders.sh'), join(dir, 'scripts/run-seeders.sh'));
    // A stand-in seeder that reports which keys reached its environment.
    writeFileSync(
      join(dir, 'scripts/seed-probe.mjs'),
      `const keys = ['FINNHUB_API_KEY', 'NASA_FIRMS_API_KEY', 'ALPHA_VANTAGE_API_KEY', 'TRAVELPAYOUTS_API_TOKEN', 'LLM_API_URL', 'OPENROUTER_API_KEY'];
       console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));`,
    );
    writeFileSync(join(dir, '.env'), 'REDIS_TOKEN=test-token\n');
    writeFileSync(join(dir, 'docker-compose.override.yml'), overrideYaml);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, SEED_TIMEOUT: '0' };
    const out = execFileSync('sh', [join(dir, 'scripts/run-seeders.sh')], { env, encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith('→ seed-probe.mjs'));
    assert.ok(line, `probe did not run:\n${out}`);
    assert.match(line, /OK$/, `probe failed:\n${out}`);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function probeEnv(overrideYaml, extraDotEnv = '') {
  // Shim `node` so each seeder invocation dumps the environment the wrapper
  // built (the wrapper itself only prints a seeder's last output line).
  const dir = mkdtempSync(join(tmpdir(), 'wm-run-seeders-env-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'bin'));
    copyFileSync(join(repoRoot, 'scripts/run-seeders.sh'), join(dir, 'scripts/run-seeders.sh'));
    writeFileSync(join(dir, 'scripts/seed-probe.mjs'), '');
    writeFileSync(join(dir, '.env'), `REDIS_TOKEN=test-token\n${extraDotEnv}`);
    writeFileSync(join(dir, 'docker-compose.override.yml'), overrideYaml);
    writeFileSync(join(dir, 'bin/node'), `#!/bin/sh\nenv > "${join(dir, 'env.out')}"\n`, { mode: 0o755 });
    const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: process.env.HOME, SEED_TIMEOUT: '0' };
    execFileSync('sh', [join(dir, 'scripts/run-seeders.sh')], { env, encoding: 'utf8' });
    const dump = readFileSync(join(dir, 'env.out'), 'utf8');
    return Object.fromEntries(
      dump.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TEMPLATE_WITH_COMMENTS = `services:
  worldmonitor:
    environment:
      # Markets
      FINNHUB_API_KEY: "fh-123"      # https://finnhub.io (free tier)
      ALPHA_VANTAGE_API_KEY: 'av-456' # equity fallback + seeders
      NASA_FIRMS_API_KEY: "firms-789" # REQUIRED for seed-fire-detections.mjs
      TRAVELPAYOUTS_API_TOKEN: "tp-1" # flight prices
      LLM_API_URL: "http://host.docker.internal:11434/v1/chat/completions"  # Ollama
      OPENROUTER_API_KEY: ""          # left empty on purpose
`;

test('exports keys whose override lines carry trailing comments', () => {
  const env = probeEnv(TEMPLATE_WITH_COMMENTS);
  assert.equal(env.FINNHUB_API_KEY, 'fh-123');
  assert.equal(env.ALPHA_VANTAGE_API_KEY, 'av-456');
  assert.equal(env.NASA_FIRMS_API_KEY, 'firms-789');
  // Not read by any seeder, so it stays out of the seeder environment.
  assert.equal(env.TRAVELPAYOUTS_API_TOKEN, undefined);
  // A '#' inside a value is not a comment: URL fragments must survive.
  assert.equal(env.LLM_API_URL, 'http://host.docker.internal:11434/v1/chat/completions');
});

test('an empty override value does not clobber a key set in .env', () => {
  const env = probeEnv(`services:
  worldmonitor:
    environment:
      OPENROUTER_API_KEY: ""          # left empty on purpose
`, 'OPENROUTER_API_KEY=from-dotenv\n');
  assert.equal(env.OPENROUTER_API_KEY, 'from-dotenv');
});

test('quoted values keep a " #" and shell metacharacters verbatim', () => {
  const env = probeEnv(`services:
  worldmonitor:
    environment:
      ACLED_PASSWORD: "abc #def"      # a password containing space-hash
      ACLED_EMAIL: 'ops@example.org' # single-quoted
      FRED_API_KEY: "it's \$HOME"     # apostrophe and a dollar sign
      EIA_API_KEY: plain-value       # unquoted, trailing comment
`, 'ACLED_PASSWORD=from-dotenv\n');
  assert.equal(env.ACLED_PASSWORD, 'abc #def');
  assert.equal(env.ACLED_EMAIL, 'ops@example.org');
  assert.equal(env.FRED_API_KEY, "it's $HOME");
  assert.equal(env.EIA_API_KEY, 'plain-value');
});

test('ignores comment-only lines and keys outside the allowlist', () => {
  const env = probeEnv(`services:
  worldmonitor:
    environment:
      # FINNHUB_API_KEY: "commented-out"
      SOME_OTHER_SECRET: "nope"   # not a seeder key
`);
  assert.equal(env.FINNHUB_API_KEY, undefined);
  assert.equal(env.SOME_OTHER_SECRET, undefined);
});

test('the wrapper still runs a seeder with the override present', () => {
  runWithOverride(TEMPLATE_WITH_COMMENTS);
});
