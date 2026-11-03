// Small JSON preferences file (theme, animation toggle). Never holds credentials.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// map: the map view's position, layers and imagery choices (views/map.mjs).
export const DEFAULT_PREFS = { theme: 'neon', animations: true, view: 'overview', map: null };

export function prefsPath(env = process.env, home = homedir()) {
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'worldmonitor', 'tui.json');
}

export function loadPrefs(env = process.env, home = homedir()) {
  try {
    const parsed = JSON.parse(readFileSync(prefsPath(env, home), 'utf8'));
    return { ...DEFAULT_PREFS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs, env = process.env, home = homedir()) {
  try {
    const file = prefsPath(env, home);
    mkdirSync(dirname(file), { recursive: true });
    const known = { ...DEFAULT_PREFS };
    for (const k of Object.keys(DEFAULT_PREFS)) if (prefs && prefs[k] !== undefined) known[k] = prefs[k];
    writeFileSync(file, `${JSON.stringify(known, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
