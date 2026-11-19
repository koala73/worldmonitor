// `worldmonitor web`: open the original web dashboard. Inside a WorldMonitor
// repository checkout this starts the Vite dev server and opens it; elsewhere
// it opens the hosted dashboard in the default browser.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openExternal } from './video.mjs';

export const HOSTED_DASHBOARD_URL = 'https://www.worldmonitor.app/dashboard';

function isWorldMonitorRoot(dir) {
  try {
    if (!existsSync(join(dir, 'vite.config.ts'))) return false;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return pkg && pkg.name === 'world-monitor' && pkg.scripts && typeof pkg.scripts.dev === 'string';
  } catch {
    return false;
  }
}

// Walk up from `start` looking for the repository root; also try the CLI's own
// parent directory (the CLI lives in <repo>/cli when run from a checkout).
export function findRepoRoot(start = process.cwd(), selfUrl = import.meta.url) {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (isWorldMonitorRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const here = resolve(dirname(fileURLToPath(selfUrl)), '..', '..', '..');
    if (isWorldMonitorRoot(here)) return here;
  } catch {
    // not a file URL
  }
  return null;
}

export async function runWeb({ options = {}, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), env = process.env, spawnImpl = spawn, open = openExternal, cwd = process.cwd(), platform = process.platform } = {}) {
  const root = options.hosted ? null : findRepoRoot(cwd);
  if (!root) {
    const url = options.url || HOSTED_DASHBOARD_URL;
    stdout(`Opening ${url}\n`);
    if (!options.noOpen) open(url);
    return 0;
  }
  const port = String(options.port || env.PORT || 5173);
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) {
    stderr(`Invalid port: ${port}\n`);
    return 2;
  }
  stdout(`WorldMonitor checkout found at ${root}\nStarting the web dashboard: npm run dev -- --port ${port}\n`);
  // Node refuses to spawn .cmd files without a shell on Windows (CVE-2024-27980),
  // so npm.cmd runs through one there; every argument is a fixed literal or the
  // digits-only port checked above.
  const win = platform === 'win32';
  // BROWSER=none stops Vite's own `server.open`, so this function alone opens
  // the browser, once, and --no-open is honoured.
  const childEnv = { ...env, BROWSER: 'none' };
  let child;
  try {
    child = spawnImpl(win ? 'npm.cmd' : 'npm', ['run', 'dev', '--', '--port', port, '--strictPort'], { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], env: childEnv, shell: win });
  } catch (err) {
    stderr(`Could not start the dev server: ${err.message}\n`);
    return 1;
  }
  let opened = options.noOpen === true;
  let pending = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout(text);
    if (opened) return;
    // Match whole lines only: the URL can arrive split across chunks.
    const lines = (pending + text).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const m = /(https?:\/\/(?:localhost|127\.0\.0\.1)[^\s]*)/.exec(line.replace(/\x1b\[[0-9;]*m/g, ''));
      if (m) {
        opened = true;
        pending = '';
        open(m[1]);
        return;
      }
    }
  });
  return new Promise((resolveExit) => {
    const forward = () => child.kill('SIGINT');
    const settle = (code) => {
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
      resolveExit(code);
    };
    child.on('error', (err) => {
      stderr(`Could not start the dev server: ${err.message}\n`);
      settle(1);
    });
    child.on('exit', (code) => settle(code === null ? 1 : code));
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
  });
}
