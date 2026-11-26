// Playback state for a storyboard: which scene, how far into it, paused,
// speed, loop. Time is injected so tests and the headless app can step it.
import { normalizeStoryboard } from '../science/storyboard.mjs';

export class Player {
  constructor(storyboard, { now = () => Date.now() } = {}) {
    this.now = now;
    this.sb = storyboard && Array.isArray(storyboard.scenes) ? storyboard : normalizeStoryboard(storyboard || {});
    this.index = 0;
    this.startedAt = now();
    this.paused = false;
    this.pausedAt = 0;
    this.speed = 1;
    this.loop = true;
    this.ended = false;
    this.pace = 26; // ms per narration character the typewriter runs at; voice mode slows it to speech pace
    this.hold = null; // () => bool: keep the scene on screen past its end (speech still playing)
    this.lastEvent = null; // for the view: 'next' | 'prev' | 'restart'
  }

  get scene() {
    return this.sb.scenes[this.index] || null;
  }

  get count() {
    return this.sb.scenes.length;
  }

  // A scene lasts at least as long as its narration takes to type at the current pace.
  durationOf(s) {
    if (!s) return 0;
    return Math.max(s.duration, (s.narration.length * this.pace) / 1000 + 3);
  }

  // Seconds into the current scene.
  time(now = this.now()) {
    const base = this.paused ? this.pausedAt : now;
    return Math.max(0, ((base - this.startedAt) / 1000) * this.speed);
  }

  tick(now = this.now()) {
    const s = this.scene;
    if (!s || this.paused || this.ended) return false;
    const dur = this.durationOf(s);
    const t = this.time(now);
    if (t >= dur) {
      if (this.hold && t < dur + 25 && this.hold()) return false;
      if (this.index + 1 < this.count) {
        this.index += 1;
        this.startedAt = now;
      } else if (this.loop) {
        this.index = 0;
        this.startedAt = now;
      } else {
        this.ended = true;
      }
      this.lastEvent = 'advance';
      return true;
    }
    return false;
  }

  seek(i, now = this.now()) {
    if (!this.count) return;
    this.index = ((i % this.count) + this.count) % this.count;
    this.startedAt = now;
    this.pausedAt = now;
    this.ended = false;
    this.lastEvent = 'seek';
  }

  next(now = this.now()) {
    this.seek(this.index + 1, now);
  }

  prev(now = this.now()) {
    // Early in a scene, go to the previous one; later, restart this one.
    if (this.time(now) > 4) this.seek(this.index, now);
    else this.seek(this.index - 1, now);
  }

  togglePause(now = this.now()) {
    if (this.paused) {
      this.startedAt += now - this.pausedAt;
      this.paused = false;
    } else {
      this.pausedAt = now;
      this.paused = true;
    }
  }

  // Jump within the scene by `sec` (keeps pause state).
  scrub(sec, now = this.now()) {
    const t = Math.max(0, Math.min(this.durationOf(this.scene) - 0.01, this.time(now) + sec));
    const base = this.paused ? this.pausedAt : now;
    this.startedAt = base - (t / this.speed) * 1000;
  }

  setSpeed(k, now = this.now()) {
    const t = this.time(now);
    this.speed = Math.max(0.25, Math.min(4, k));
    const base = this.paused ? this.pausedAt : now;
    this.startedAt = base - (t / this.speed) * 1000;
  }

  restart(now = this.now()) {
    this.seek(0, now);
    this.ended = false;
    this.paused = false;
  }

  // Callout active at scene time t: the latest one that started, until the next starts.
  activeCallout(t = this.time()) {
    const s = this.scene;
    if (!s) return null;
    let cur = null;
    for (const c of s.callouts) {
      if (c.t <= t) cur = c;
      else break;
    }
    return cur;
  }

  progress(now = this.now()) {
    const s = this.scene;
    const t = this.time(now);
    const dur = this.durationOf(s);
    const total = this.sb.scenes.reduce((a, x) => a + this.durationOf(x), 0);
    const before = this.sb.scenes.slice(0, this.index).reduce((a, x) => a + this.durationOf(x), 0);
    return { index: this.index, total: this.count, t, duration: dur, sceneRatio: dur ? Math.min(1, t / dur) : 0, overall: total ? Math.min(1, (before + Math.min(t, dur)) / total) : 0, remainingS: Math.max(0, (total - before - t) / this.speed), totalS: total };
  }
}
