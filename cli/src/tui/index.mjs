// Launches the terminal dashboard: wires the real terminal (raw mode, alt
// screen, mouse) to the App, runs the boot loader and the frame loop.
import { readFileSync } from 'node:fs';
import { SEQ, detectColorDepth, setTitle } from './term/ansi.mjs';
import { App } from './app.mjs';
import { createClient } from './data/client.mjs';
import { Store } from './data/store.mjs';
import { loadPrefs, savePrefs } from './prefs.mjs';
import { createViews } from './views/index.mjs';
import { detectPlayer } from './video.mjs';
import { USER_AGENT } from '../core.mjs';

export function loadCatalog() {
  return JSON.parse(readFileSync(new URL('./data/catalog.generated.json', import.meta.url), 'utf8'));
}

export async function launchTui({ options = {}, config = {}, env = process.env, stdin = process.stdin, stdout = process.stdout, fetchImpl } = {}) {
  const apiKey = options.apiKey || config.apiKey || '';
  const client = createClient({
    baseUrl: options.baseUrl || env.WORLDMONITOR_TUI_BASE_URL || config.baseUrl || undefined,
    apiKey,
    userAgent: USER_AGENT.replace('worldmonitor-cli', 'worldmonitor-tui'),
    fetch: fetchImpl,
  });
  const store = new Store(client);
  const prefs = loadPrefs(env);
  if (options.theme) prefs.theme = options.theme;
  if (options.noAnim) prefs.animations = false;
  const catalog = loadCatalog();
  const depth = detectColorDepth(env);
  const cols = Number(env.WM_TUI_COLS) || stdout.columns || 120;
  const rows = Number(env.WM_TUI_ROWS) || stdout.rows || 40;

  const app = new App({
    store,
    catalog,
    prefs,
    savePrefs: (p) => savePrefs(p, env),
    env,
    out: (s) => stdout.write(s),
    cols,
    rows,
    depth,
    createViews,
    player: detectPlayer(env),
    apiKeyPresent: Boolean(apiKey),
    fetchImpl,
  });

  const fps = Math.max(5, Math.min(60, Number(options.fps) || 20));
  let timer = null;
  let escTimer = null;
  let active = true;

  const enter = () => {
    stdout.write(SEQ.altScreenOn + SEQ.cursorHide + SEQ.mouseOn + setTitle('World Monitor'));
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
  };
  const leave = () => {
    stdout.write(SEQ.mouseOff + SEQ.cursorShow + SEQ.reset + SEQ.altScreenOff);
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
    stdin.pause();
  };

  const onData = (chunk) => {
    if (app.suspended) return;
    app.feed(chunk);
    if (escTimer) clearTimeout(escTimer);
    if (app.decoder.pending) escTimer = setTimeout(() => app.flushInput(), 40);
  };
  const onResize = () => app.resize(stdout.columns || cols, stdout.rows || rows);

  const frameLoop = () => {
    if (!active || app.suspended) return;
    if (app.dirty || app.animating()) app.render();
  };

  const shutdown = () => {
    if (!active) return;
    active = false;
    if (timer) clearInterval(timer);
    if (escTimer) clearTimeout(escTimer);
    store.stop();
    client.close();
    stdin.off('data', onData);
    stdout.off('resize', onResize);
    leave();
  };

  app.onQuit = shutdown;
  app.onSuspend = () => {
    stdin.off('data', onData);
    leave();
  };
  app.onResume = () => {
    enter();
    stdin.on('data', onData);
    app.render();
  };

  enter();
  stdin.on('data', onData);
  stdout.on('resize', onResize);
  const onSignal = () => {
    shutdown();
    process.exit(0);
  };
  // While mpv plays in the terminal it shares the foreground process group, so
  // Ctrl-C reaches both; it should stop the video and return to the dashboard.
  const onInterrupt = () => {
    if (app.suspended) return;
    onSignal();
  };
  process.on('SIGINT', onInterrupt);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  const onCrash = (err) => {
    shutdown();
    process.stderr.write(`worldmonitor tui crashed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  };
  process.once('uncaughtException', onCrash);
  process.once('unhandledRejection', onCrash);

  timer = setInterval(frameLoop, Math.round(1000 / fps));
  app.render();
  store.boot((progress, stage) => {
    if (!active) return;
    app.boot.progress = progress;
    app.boot.stage = stage;
    app.markDirty();
  }).then(() => {
    if (active) store.start();
  });

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (!active) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onSignal);
  process.off('SIGHUP', onSignal);
  process.off('uncaughtException', onCrash);
  process.off('unhandledRejection', onCrash);
  return 0;
}
