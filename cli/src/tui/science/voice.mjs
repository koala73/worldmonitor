// Text-to-speech for the Phenomena explainer, using whatever the machine
// already has: `say` on macOS, `espeak-ng` / `espeak` on Linux. Nothing is
// installed and nothing leaves the machine. One utterance plays at a time; a
// new scene, a pause or a seek stops the old one.
import { spawn } from 'node:child_process';
import { findExecutable } from '../video.mjs';

export const BASE_WPM = 175; // the pace the narration typewriter is tuned to

export function detectSpeech(env = process.env) {
  if (env.WM_TUI_NO_VOICE) return null;
  const say = findExecutable('say', env);
  if (say) return { bin: say, kind: 'say' };
  const espeak = findExecutable('espeak-ng', env) || findExecutable('espeak', env);
  if (espeak) return { bin: espeak, kind: 'espeak' };
  return null;
}

// Arguments for one utterance; the text goes on stdin so length is no issue.
export function speechArgs(engine, { rate = 1, voice = '' } = {}) {
  const wpm = Math.round(BASE_WPM * Math.max(0.25, Math.min(4, rate)));
  if (engine.kind === 'say') return ['-r', String(wpm), ...(voice ? ['-v', voice] : [])];
  return ['-s', String(wpm), ...(voice ? ['-v', voice] : []), '--stdin'];
}

// Strip things that read badly aloud: callout arrows, bare URLs, brackets.
export function speakable(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[→⇢⟶]/g, ', then ')
    .replace(/[◆◈▣⚠✦●■▲]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Voice {
  constructor({ env = process.env, spawnImpl = spawn, voice = '' } = {}) {
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.engine = detectSpeech(env);
    this.voiceName = voice || env.WM_VOICE || '';
    this.current = null; // { key, child, startedAt, text }
    this.spoken = 0;
  }

  get available() {
    return Boolean(this.engine);
  }

  get speaking() {
    return Boolean(this.current && !this.current.done);
  }

  get currentKey() {
    return this.current ? this.current.key : null;
  }

  speak(text, { key = '', rate = 1 } = {}) {
    if (!this.engine) return false;
    this.stop();
    const clean = speakable(text);
    if (!clean) return false;
    let child;
    try {
      child = this.spawnImpl(this.engine.bin, speechArgs(this.engine, { rate, voice: this.voiceName }), { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      return false;
    }
    const cur = { key, child, startedAt: Date.now(), text: clean, done: false };
    this.current = cur;
    this.spoken += 1;
    child.on('exit', () => {
      cur.done = true;
    });
    child.on('error', () => {
      cur.done = true;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(clean);
    return true;
  }

  stop() {
    const cur = this.current;
    if (cur && !cur.done) {
      cur.done = true;
      try {
        cur.child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    this.current = null;
  }
}
