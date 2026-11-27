// Runs each seeder with runSeed replaced by a recorder and returns the arguments it
// passed, so tests read the TTLs and keys a seeder really uses instead of parsing its
// source. fetch is stubbed, node:http(s) and curl go to a dead proxy, and the Redis
// URL cannot resolve, so nothing is fetched or written.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTER = fileURLToPath(new URL('./runseed-probe/register.mjs', import.meta.url));
const MARK = '@@RUNSEED ';

// A seeder that checks for its credentials before calling runSeed needs them set to
// reach it. Every credential named in .env.example gets a placeholder; feature flags
// and URLs keep their defaults, so the probe records the repo's default behavior.
function placeholderCredentials(repoRoot) {
  const names = readFileSync(join(repoRoot, '.env.example'), 'utf8')
    .split('\n')
    .map((line) => line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/)?.[1])
    .filter((name) => name && !name.startsWith('VITE_') && /(KEY|TOKEN|SECRET|CLIENT_ID|PASSWORD|_API)$/.test(name));
  return Object.fromEntries(names.map((name) => [name, 'runseed-probe']));
}

export function seederFiles(scriptsDir) {
  return readdirSync(scriptsDir).filter((f) => /^seed-.*\.mjs$/.test(f) && !f.startsWith('seed-bundle-'));
}

const DEAD_PROXY = 'http://127.0.0.1:9';

// NODE_ENV=test keeps loadEnvFile() from reading the checkout's .env.local, so a
// developer's real credentials and flags never reach a seeder and local results
// match CI.
export function probeEnv(repoRoot) {
  return {
    ...placeholderCredentials(repoRoot),
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: DEAD_PROXY,
    HTTPS_PROXY: DEAD_PROXY,
    http_proxy: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    UPSTASH_REDIS_REST_URL: 'https://runseed-probe.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'runseed-probe',
  };
}

function probeOne(scriptsDir, file, timeoutMs, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', REGISTER, join(scriptsDir, file)], {
      cwd: join(scriptsDir, '..'),
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    let hung = false;
    const timer = setTimeout(() => { hung = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', () => clearTimeout(timer));
    // 'close' waits for stdout to drain; 'exit' can fire before the last line arrives.
    child.on('close', () => {
      const calls = out.split('\n').filter((l) => l.startsWith(MARK)).map((l) => JSON.parse(l.slice(MARK.length)));
      done({ file, calls, hung });
    });
  });
}

// The recorder exits as soon as runSeed is called, and a seeder that never calls it
// exits on its own error, so timeoutMs only stops a seeder that hangs.
export async function recordRunSeedCalls(scriptsDir, { concurrency = 8, timeoutMs = 60_000 } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 5)) {
    throw new Error(`runseed-probe needs Node 24.5+ for NODE_USE_ENV_PROXY; this is ${process.versions.node}`);
  }
  const queue = seederFiles(scriptsDir);
  const env = probeEnv(join(scriptsDir, '..'));
  const results = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) results.push(await probeOne(scriptsDir, queue.shift(), timeoutMs, env));
  }));
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

// seed-meta key -> { writer, ttlSeconds } for every key a recorded runSeed call writes.
// runSeed writes seed-meta:<domain>:<resource>; an extra key writes its own metaKey
// with its own ttl, or the canonical ttlSeconds when it declares none. A null TTL is
// a persistent key. When several writers share a key, the shortest TTL is kept.
export function seedMetaWriters(results) {
  const writers = new Map();
  const record = (key, writer, ttlSeconds) => {
    const prev = writers.get(key);
    if (prev && (ttlSeconds == null || (prev.ttlSeconds != null && prev.ttlSeconds <= ttlSeconds))) return;
    writers.set(key, { writer, ttlSeconds });
  };
  for (const { file, calls } of results) {
    for (const c of calls) {
      record(`seed-meta:${c.domain}:${c.resource}`, file, c.ttlSeconds);
      for (const ek of c.extraKeys) {
        if (ek.metaKey) record(ek.metaKey, `${file} extra key ${ek.key}`, ek.ttl ?? c.ttlSeconds);
      }
    }
  }
  return writers;
}
