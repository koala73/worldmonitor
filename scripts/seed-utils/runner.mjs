import { spawn } from 'node:child_process';

/**
 * Fork a seed script as a child process and track its execution.
 *
 * @param {string} name — seeder name for logging
 * @param {object} opts
 * @param {string} opts.scriptPath — path to the script (or process.execPath for tests)
 * @param {string[]} [opts.args] — arguments (default: none)
 * @param {number} [opts.timeoutMs=120000] — kill after this many ms
 * @param {object} [opts.env] — additional env vars (merged with process.env)
 * @returns {Promise<{ name: string, exitCode: number|null, status: 'ok'|'error'|'timeout', durationMs: number }>}
 */
export function forkSeeder(name, opts) {
  const { scriptPath, args = [], timeoutMs = 120_000, env } = opts;

  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(scriptPath, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...env },
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        // Give 3s for graceful shutdown, then SIGKILL
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 3000);
        resolve({ name, exitCode: null, status: 'timeout', durationMs: Date.now() - start });
      }
    }, timeoutMs);

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          name,
          exitCode: code,
          status: code === 0 ? 'ok' : 'error',
          durationMs: Date.now() - start,
        });
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          name,
          exitCode: null,
          status: 'error',
          durationMs: Date.now() - start,
          error: err.message,
        });
      }
    });
  });
}
