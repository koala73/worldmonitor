// Video playback bridge. The TUI never decodes video itself: it hands streams
// to mpv (which uses yt-dlp for YouTube) either inside the terminal, through
// mpv's kitty-graphics or truecolor-cell outputs, or in an external window. The
// browser is the fallback when mpv is missing.
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export function findExecutable(name, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// 'kitty' when the terminal speaks the Kitty graphics protocol, else 'tct'.
export function detectTerminalGraphics(env = process.env) {
  if (env.WM_TUI_VO) return env.WM_TUI_VO;
  // tmux and screen do not pass the kitty graphics protocol through by default.
  if (env.TMUX || /^screen/.test(String(env.TERM || ''))) return 'tct';
  const tp = String(env.TERM_PROGRAM || '').toLowerCase();
  const term = String(env.TERM || '').toLowerCase();
  if (env.KITTY_WINDOW_ID || term.includes('kitty')) return 'kitty';
  if (tp === 'ghostty' || term.includes('ghostty')) return 'kitty';
  if (tp === 'wezterm' || env.WEZTERM_EXECUTABLE) return 'kitty';
  if (env.KONSOLE_VERSION) return 'kitty';
  return 'tct';
}

export function detectPlayer(env = process.env) {
  const mpv = findExecutable('mpv', env);
  const ytdlp = findExecutable('yt-dlp', env) || findExecutable('youtube-dl', env);
  return { mpv, ytdlp, vo: detectTerminalGraphics(env) };
}

export function mpvArgs(url, { mode = 'terminal', vo = 'tct', title = 'World Monitor' } = {}) {
  const common = [
    `--title=${title}`,
    '--really-quiet',
    '--ytdl-format=bv*[height<=720]+ba/b[height<=720]/b',
    '--hls-bitrate=max',
    '--cache=yes',
    '--demuxer-max-bytes=64MiB',
    '--force-seekable=no',
  ];
  if (mode === 'window') return [...common, '--force-window=yes', '--keep-open=no', url];
  const term = [`--vo=${vo}`, '--profile=low-latency', '--osd-level=0'];
  if (vo === 'tct') term.push('--vo-tct-algo=half-blocks', '--vo-tct-256=no');
  return [...common, ...term, url];
}

// Run mpv in the terminal; the caller suspends the TUI before and resumes after.
export function playInTerminal(url, { player, title, onExit, spawnImpl = spawn }) {
  const args = mpvArgs(url, { mode: 'terminal', vo: player.vo, title });
  return new Promise((resolve) => {
    const child = spawnImpl(player.mpv, args, { stdio: 'inherit' });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('exit', (code, signal) => {
      const result = { ok: code === 0 || signal === 'SIGINT' || code === 4, code, signal };
      if (onExit) onExit(result);
      resolve(result);
    });
  });
}

export function playInWindow(url, { player, title, spawnImpl = spawn }) {
  const args = mpvArgs(url, { mode: 'window', title });
  try {
    const child = spawnImpl(player.mpv, args, { stdio: 'ignore', detached: true });
    // A spawn failure (mpv removed, not executable) arrives as an async 'error'
    // event; without a listener it would crash the dashboard.
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Only http(s) links are opened. Links come from third-party feeds, so the
// Windows path avoids cmd.exe, which would interpret `&`, `|` and `^` in them.
export function openExternal(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  let href;
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'only http(s) links can be opened' };
    href = parsed.href;
  } catch {
    return { ok: false, error: 'not a valid URL' };
  }
  const [cmd, args] = platform === 'darwin' ? ['open', [href]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', href]] : ['xdg-open', [href]];
  try {
    const child = spawnImpl(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
