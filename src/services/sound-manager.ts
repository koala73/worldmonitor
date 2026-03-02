/**
 * Sound Manager — Mode Transition & Alert Audio
 *
 * Synthesizes distinct sounds for each monitoring mode using the Web Audio API.
 * No audio files required — all sounds are generated procedurally.
 *
 * War Mode:      rapid staccato alarm (submarine battle stations feel)
 * Finance Mode:  ascending market chime (trading floor open)
 * Peace Mode:    soft resonant tone (situation resolved)
 * Disaster Mode: low rumble + urgent descending klaxon (seismic alert)
 *
 * Sounds respect the global mute setting stored at localStorage key 'wm-sound-muted'.
 * AudioContext is created lazily on first interaction to satisfy browser autoplay policy.
 */

import type { AppMode, ModeChangedDetail } from '@/services/mode-manager';

const MUTE_KEY = 'wm-sound-muted';

let _ctx: AudioContext | null = null;
let _initialized = false;

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/** Initialize the sound manager — wire mode-change events. Call once from App.init(). */
export function initSoundManager(): void {
  if (_initialized) return;
  _initialized = true;

  document.addEventListener('wm:mode-changed', ((e: CustomEvent<ModeChangedDetail>) => {
    const { mode, prev } = e.detail;
    if (mode !== prev) {
      _playModeSound(mode);
    }
  }) as EventListener);

  // Lazy-init AudioContext on first user gesture so browsers allow audio
  const unlockAudio = () => {
    if (!_ctx) {
      try {
        _ctx = new AudioContext();
      } catch {
        // Audio unavailable
      }
    }
    document.removeEventListener('click', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  };
  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  _initSpatialAudio();
}

/** Toggle mute. Returns the new muted state. */
export function toggleMute(): boolean {
  const muted = !isMuted();
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  return muted;
}

/** Returns true if sounds are currently muted. */
export function isMuted(): boolean {
  return localStorage.getItem(MUTE_KEY) === '1';
}

// ──────────────────────────────────────────────────────────────────────────────
// Sound synthesis
// ──────────────────────────────────────────────────────────────────────────────

function _getCtx(): AudioContext | null {
  if (_ctx) return _ctx;
  try {
    _ctx = new AudioContext();
    return _ctx;
  } catch {
    return null;
  }
}

function _playModeSound(mode: AppMode): void {
  if (isMuted()) return;
  switch (mode) {
    case 'war':      return _playWarAlarm();
    case 'finance':  return _playFinanceChime();
    case 'peace':    return _playPeaceTone();
    case 'disaster': return _playDisasterAlert();
  }
}

/**
 * War Mode alarm — rapid descending staccato beeps (submarine battle stations).
 * Four short sawtooth bursts at decreasing pitches, harsh and urgent.
 */
function _playWarAlarm(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  const freqs = [880, 740, 880, 660];
  const noteMs = 70;
  const gapMs = 35;

  freqs.forEach((freq, i) => {
    const start = ctx.currentTime + i * ((noteMs + gapMs) / 1000);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.35, start + 0.005);
    gain.gain.setValueAtTime(0.35, start + noteMs / 1000 - 0.01);
    gain.gain.linearRampToValueAtTime(0, start + noteMs / 1000);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + noteMs / 1000 + 0.01);
  });
}

/**
 * Finance Mode chime — ascending 3-note arpeggio (market opening bell).
 * Clean sine tones with smooth attack/decay: C5 → E5 → G5.
 */
function _playFinanceChime(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
  const noteMs = 140;
  const overlapMs = 40;

  notes.forEach((freq, i) => {
    const start = ctx.currentTime + i * ((noteMs - overlapMs) / 1000);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.28, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + noteMs / 1000 + 0.08);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + noteMs / 1000 + 0.1);
  });
}

/**
 * Disaster Mode alert — low seismic rumble followed by descending klaxon.
 * Sub-bass drone (80 Hz) for the rumble, then two urgent descending tones.
 */
function _playDisasterAlert(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  // Sub-bass rumble — square wave at 80 Hz, 0.6s decay
  const rumbleOsc = ctx.createOscillator();
  const rumbleGain = ctx.createGain();
  rumbleOsc.type = 'square';
  rumbleOsc.frequency.setValueAtTime(80, ctx.currentTime);
  rumbleGain.gain.setValueAtTime(0, ctx.currentTime);
  rumbleGain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.05);
  rumbleGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
  rumbleOsc.connect(rumbleGain);
  rumbleGain.connect(ctx.destination);
  rumbleOsc.start(ctx.currentTime);
  rumbleOsc.stop(ctx.currentTime + 0.65);

  // Descending klaxon — two sawtooth bursts dropping 480→340 Hz
  const klaxonFreqs = [480, 340];
  const noteMs = 180;
  const gapMs = 60;
  klaxonFreqs.forEach((freq, i) => {
    const start = ctx.currentTime + 0.4 + i * ((noteMs + gapMs) / 1000);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.30, start + 0.01);
    gain.gain.setValueAtTime(0.30, start + noteMs / 1000 - 0.02);
    gain.gain.linearRampToValueAtTime(0, start + noteMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + noteMs / 1000 + 0.02);
  });
}

/**
 * Peace Mode tone — single soft resonant bell tone (situation resolved).
 * Pure sine at 432 Hz with a slow natural decay.
 */
function _playPeaceTone(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  const freq = 432;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, ctx.currentTime);

  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 1.3);
}

// ── Spatial Audio Layer ──────────────────────────────────────────────────────
//
// Three continuous ambient layers:
//   1. Tension drone  — 432 Hz sine, pitch tracks war-score (0-100 → 432-512 Hz)
//   2. Ambient chatter — bandpass-filtered noise clicks, rate scales with
//      recent breaking-news event count (1/8s → 1/1s)
//   3. Escalation pings — two-tone descending sine on each wm:breaking-news
//
// All layers feed through a shared _masterGain so volume & visibility mute
// apply uniformly.  Mode-transition sounds still go straight to ctx.destination.
//
// localStorage keys (public so UI can read/write them):
//   wm-spatial-volume   '0.00'–'1.00'   default 0.50
//   wm-spatial-ambient  '0' | '1'        default 1
//   wm-spatial-drone    '0' | '1'        default 1
//   wm-spatial-pings    '0' | '1'        default 1

const SPATIAL_VOLUME_KEY  = 'wm-spatial-volume';
const SPATIAL_AMBIENT_KEY = 'wm-spatial-ambient';
const SPATIAL_DRONE_KEY   = 'wm-spatial-drone';
const SPATIAL_PINGS_KEY   = 'wm-spatial-pings';
const IDLE_MUTE_MS        = 5 * 60_000; // fade to silence after 5 min idle

let _masterGain: GainNode | null = null;
let _droneOsc: OscillatorNode | null = null;
let _droneGainNode: GainNode | null = null;
let _ambientTimer: ReturnType<typeof setTimeout> | null = null;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _recentBreakingCount = 0; // decays by 3 after 5 min; drives chatter density
let _warScore = 0;            // 0-100 from wm:war-score; drives drone pitch

// ── Public API ────────────────────────────────────────────────────────────────

/** Current spatial master volume (0–1). */
export function getSpatialVolume(): number {
  const v = parseFloat(localStorage.getItem(SPATIAL_VOLUME_KEY) || '0.5');
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

/** Set spatial master volume (0–1) and persist. */
export function setSpatialVolume(v: number): void {
  const clamped = Math.max(0, Math.min(1, v));
  localStorage.setItem(SPATIAL_VOLUME_KEY, clamped.toFixed(2));
  _applyMasterVolume();
}

/** Whether a spatial layer is enabled ('ambient' | 'drone' | 'pings'). */
export function isSpatialLayerEnabled(layer: 'ambient' | 'drone' | 'pings'): boolean {
  const key = layer === 'ambient' ? SPATIAL_AMBIENT_KEY
            : layer === 'drone'   ? SPATIAL_DRONE_KEY
            :                       SPATIAL_PINGS_KEY;
  return localStorage.getItem(key) !== '0';
}

/** Enable or disable a spatial layer and apply immediately. */
export function setSpatialLayerEnabled(layer: 'ambient' | 'drone' | 'pings', enabled: boolean): void {
  const key = layer === 'ambient' ? SPATIAL_AMBIENT_KEY
            : layer === 'drone'   ? SPATIAL_DRONE_KEY
            :                       SPATIAL_PINGS_KEY;
  localStorage.setItem(key, enabled ? '1' : '0');
  if (layer === 'drone')   enabled ? _startDrone()    : _stopDrone();
  if (layer === 'ambient') enabled ? _scheduleChatter() : _cancelChatter();
}

// ── Internal init (called from initSoundManager) ──────────────────────────────

function _initSpatialAudio(): void {
  // Escalation ping + ambient density bump on every breaking alert
  document.addEventListener('wm:breaking-news', ((e: CustomEvent) => {
    const { threatLevel } = e.detail as { threatLevel?: string };
    _recentBreakingCount = Math.min(_recentBreakingCount + 3, 20);
    setTimeout(() => { _recentBreakingCount = Math.max(0, _recentBreakingCount - 3); }, 5 * 60_000);
    if (isSpatialLayerEnabled('pings') && !isMuted()) {
      _playEscalationPing(threatLevel as 'critical' | 'high' | undefined);
    }
  }) as EventListener);

  // Drone pitch tracks war threat score
  document.addEventListener('wm:war-score', ((e: CustomEvent) => {
    _warScore = (e.detail as { score: number }).score ?? 0;
    _updateDronePitch();
  }) as EventListener);

  // Visibility mute/unmute
  document.addEventListener('visibilitychange', _onVisibilityChange);

  // Idle mute wiring
  _wireIdleMute();

  // Start persistent layers after first user gesture (autoplay policy)
  const _startAfterGesture = () => {
    const ctx = _getCtx();
    if (!ctx) return;
    _ensureMasterGain(ctx);
    if (isSpatialLayerEnabled('drone')   && !isMuted()) _startDrone();
    if (isSpatialLayerEnabled('ambient') && !isMuted()) _scheduleChatter();
  };
  document.addEventListener('click',   _startAfterGesture, { once: true });
  document.addEventListener('keydown', _startAfterGesture, { once: true });
}

// ── Tension drone ─────────────────────────────────────────────────────────────

function _startDrone(): void {
  if (_droneOsc) return;
  const ctx = _getCtx();
  if (!ctx) return;
  _ensureMasterGain(ctx);
  if (!_masterGain) return;

  _droneOsc = ctx.createOscillator();
  _droneOsc.type = 'sine';
  _droneOsc.frequency.setValueAtTime(432 + _warScore * 0.8, ctx.currentTime);

  _droneGainNode = ctx.createGain();
  _droneGainNode.gain.setValueAtTime(0, ctx.currentTime);
  _droneGainNode.gain.linearRampToValueAtTime(0.45, ctx.currentTime + 4); // 4s fade-in

  _droneOsc.connect(_droneGainNode);
  _droneGainNode.connect(_masterGain);
  _droneOsc.start();
}

function _stopDrone(): void {
  const ctx = _getCtx();
  if (ctx && _droneGainNode) {
    _droneGainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
  }
  const osc = _droneOsc;
  _droneOsc = null;
  _droneGainNode = null;
  if (osc) setTimeout(() => { try { osc.stop(); } catch { /* already stopped */ } }, 2000);
}

function _updateDronePitch(): void {
  if (!_droneOsc) return;
  const ctx = _getCtx();
  if (!ctx) return;
  // 432 Hz at score 0 → 512 Hz at score 100
  _droneOsc.frequency.setTargetAtTime(432 + _warScore * 0.8, ctx.currentTime, 3.0);
}

// ── Ambient chatter ───────────────────────────────────────────────────────────

function _scheduleChatter(): void {
  if (!isSpatialLayerEnabled('ambient') || isMuted()) return;
  const ctx = _getCtx();
  if (!ctx || !_masterGain) return;

  // Gap: 8s (quiet) → 1s (after 20 breaking events). ±25% random jitter.
  const baseGap = Math.max(1000, 8000 - _recentBreakingCount * 350);
  const jitter  = (Math.random() - 0.5) * baseGap * 0.5;

  _ambientTimer = setTimeout(() => {
    if (isSpatialLayerEnabled('ambient') && !isMuted()) _playChatterClick(ctx);
    _scheduleChatter();
  }, Math.max(500, baseGap + jitter));
}

function _cancelChatter(): void {
  if (_ambientTimer !== null) { clearTimeout(_ambientTimer); _ambientTimer = null; }
}

function _playChatterClick(ctx: AudioContext): void {
  if (!_masterGain) return;
  const durS  = 0.03 + Math.random() * 0.04; // 30–70 ms noise burst
  const bufLen = Math.ceil(ctx.sampleRate * durS);
  const buf  = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const bpf = ctx.createBiquadFilter();
  bpf.type = 'bandpass';
  bpf.frequency.setValueAtTime(1800 + Math.random() * 1400, ctx.currentTime); // 1.8–3.2 kHz
  bpf.Q.setValueAtTime(3 + Math.random() * 4, ctx.currentTime);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.07, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durS);

  src.connect(bpf);
  bpf.connect(g);
  g.connect(_masterGain);
  src.start();
}

// ── Escalation pings ──────────────────────────────────────────────────────────

function _playEscalationPing(level?: 'critical' | 'high'): void {
  const ctx = _getCtx();
  if (!ctx) return;
  _ensureMasterGain(ctx);
  if (!_masterGain) return;

  const isCritical = level === 'critical';
  const freqs: [number, number] = isCritical ? [880, 660] : [660, 520];
  const peakGain = isCritical ? 0.18 : 0.12;

  freqs.forEach((freq, i) => {
    const t = ctx.currentTime + i * 0.14;
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peakGain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(g);
    g.connect(_masterGain!);
    osc.start(t);
    osc.stop(t + 0.25);
  });
}

// ── Master gain + volume ──────────────────────────────────────────────────────

function _ensureMasterGain(ctx: AudioContext): void {
  if (_masterGain) return;
  _masterGain = ctx.createGain();
  _masterGain.gain.setValueAtTime(getSpatialVolume() * 0.15, ctx.currentTime);
  _masterGain.connect(ctx.destination);
}

function _applyMasterVolume(): void {
  const ctx = _getCtx();
  if (!ctx || !_masterGain) return;
  _masterGain.gain.setTargetAtTime(getSpatialVolume() * 0.15, ctx.currentTime, 0.1);
}

// ── Idle + visibility mute ────────────────────────────────────────────────────

function _wireIdleMute(): void {
  const resetIdle = () => {
    if (_idleTimer !== null) clearTimeout(_idleTimer);
    _applyMasterVolume(); // restore if previously faded
    _idleTimer = setTimeout(() => {
      const ctx = _getCtx();
      if (ctx && _masterGain) _masterGain.gain.setTargetAtTime(0, ctx.currentTime, 1.5);
    }, IDLE_MUTE_MS);
  };
  document.addEventListener('mousemove', resetIdle, { passive: true });
  document.addEventListener('keydown',   resetIdle, { passive: true });
  resetIdle();
}

function _onVisibilityChange(): void {
  const ctx = _getCtx();
  if (!ctx || !_masterGain) return;
  if (document.hidden) {
    _masterGain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
  } else {
    _masterGain.gain.setTargetAtTime(getSpatialVolume() * 0.15, ctx.currentTime, 0.3);
  }
}
