import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIM = path.join(ROOT, 'docker', 'claude-code-shim.mjs');
export const STUB = path.join(ROOT, 'tests', 'fixtures', 'claude-stub.mjs');

/**
 * Boot the shim on an ephemeral port with the fake `claude` CLI.
 * Returns { base, stop, child }. Registers cleanup on the test context.
 */
export async function startShim(t, env = {}) {
  const child = spawn(process.execPath, [SHIM], {
    env: {
      ...process.env,
      PORT: '0',
      SHIM_API_KEY: 'test-key',
      CLAUDE_BIN: STUB,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const base = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`shim did not start: ${stderr}`)), 10_000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`shim exited ${code}: ${stderr}`)); });
  });
  let stopped = false;
  const stop = () => new Promise((resolve) => {
    if (stopped) return resolve();
    stopped = true;
    child.on('exit', resolve);
    child.kill();
  });
  if (t) t.after(stop);
  return { base, stop, child };
}
