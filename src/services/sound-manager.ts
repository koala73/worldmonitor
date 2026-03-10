/**
 * Sound Manager — Mode Transition & Alert Audio
 *
 * Synthesizes distinct sounds for each monitoring mode using the Web Audio API.
 * No audio files required — all sounds are generated procedurally.
 *
 * War Mode:      deep bass thud + rapid 6-tone staccato klaxon
 * Finance Mode:  4-note ascending bell arpeggio with rich harmonics
 * Peace Mode:    A-major chord resolution (4 sine voices, long decay)
 * Disaster Mode: sub-bass slam + 3-pass descending frequency-sweep siren
 *
 * Spatial drone: two detuned triangle oscillators at 40 Hz (sub-bass) with
 * a slow LFO tremolo — felt as a rumble, not heard as a hum.
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
 * War Mode alarm — deep bass thud followed by rapid 6-tone staccato klaxon.
 * Opens with a 55 Hz triangle slam (felt in the chest), then 6 alternating
 * sawtooth tones at 880/660 Hz — aggressive, no ambiguity.
 */
function _playWarAlarm(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  // ── Opening bass thud ──────────────────────────────────────────────────────
  const thudOsc  = ctx.createOscillator();
  const thudGain = ctx.createGain();
  thudOsc.type = 'triangle';
  thudOsc.frequency.setValueAtTime(55, ctx.currentTime);
  thudGain.gain.setValueAtTime(0, ctx.currentTime);
  thudGain.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 0.005);
  thudGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
  thudOsc.connect(thudGain);
  thudGain.connect(ctx.destination);
  thudOsc.start(ctx.currentTime);
  thudOsc.stop(ctx.currentTime + 0.2);

  // ── 6-tone staccato klaxon ─────────────────────────────────────────────────
  // Alternating high/low — 880 Hz, 660 Hz, 880 Hz, 660 Hz, 880 Hz, 660 Hz
  const klaxonFreqs = [880, 660, 880, 660, 880, 660];
  const onMs  = 90;
  const offMs = 45;

  klaxonFreqs.forEach((freq, i) => {
    const start = ctx.currentTime + 0.15 + i * ((onMs + offMs) / 1000);
    const osc   = ctx.createOscillator();
    const gain  = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.65, start + 0.004);
    gain.gain.setValueAtTime(0.65, start + onMs / 1000 - 0.008);
    gain.gain.linearRampToValueAtTime(0, start + onMs / 1000);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + onMs / 1000 + 0.01);
  });
}

/**
 * Finance Mode chime — 4-note ascending bell arpeggio (C5 → E5 → G5 → C6).
 * Each tone is layered with its third harmonic for a richer bell timbre.
 * Higher peak gain and a long trailing decay on the final note.
 */
function _playFinanceChime(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  // C5, E5, G5, C6
  const notes   = [523.25, 659.25, 783.99, 1046.5];
  const stepMs  = 130;

  notes.forEach((freq, i) => {
    const start    = ctx.currentTime + i * (stepMs / 1000);
    const isFinal  = i === notes.length - 1;
    const decayEnd = start + (isFinal ? 2.4 : 0.35);

    // Fundamental
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.45, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, decayEnd);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(decayEnd + 0.05);

    // Third harmonic — adds bell-like shimmer at 1/4 the gain
    const osc3  = ctx.createOscillator();
    const gain3 = ctx.createGain();
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(freq * 3, start);
    gain3.gain.setValueAtTime(0, start);
    gain3.gain.linearRampToValueAtTime(0.11, start + 0.006);
    gain3.gain.exponentialRampToValueAtTime(0.001, start + (isFinal ? 0.8 : 0.18));
    osc3.connect(gain3);
    gain3.connect(ctx.destination);
    osc3.start(start);
    osc3.stop(start + (isFinal ? 0.85 : 0.22));
  });
}

/**
 * Disaster Mode alert — sub-bass slam + 3-pass descending frequency-sweep siren.
 * Opens with a deep 45 Hz square-wave impact, then three rapid downward sweeps
 * from 700 → 220 Hz. Sounds like a civil-defense siren winding down under pressure.
 */
function _playDisasterAlert(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  // ── Sub-bass slam ──────────────────────────────────────────────────────────
  const slamOsc  = ctx.createOscillator();
  const slamGain = ctx.createGain();
  slamOsc.type = 'square';
  slamOsc.frequency.setValueAtTime(45, ctx.currentTime);
  slamGain.gain.setValueAtTime(0, ctx.currentTime);
  slamGain.gain.linearRampToValueAtTime(0.55, ctx.currentTime + 0.01);
  slamGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
  slamOsc.connect(slamGain);
  slamGain.connect(ctx.destination);
  slamOsc.start(ctx.currentTime);
  slamOsc.stop(ctx.currentTime + 0.5);

  // ── 3-pass descending sweep siren ─────────────────────────────────────────
  const sweepDur  = 0.32; // seconds per sweep
  const sweepGap  = 0.06;
  const numSweeps = 3;

  for (let i = 0; i < numSweeps; i++) {
    const start = ctx.currentTime + 0.35 + i * (sweepDur + sweepGap);
    const end   = start + sweepDur;

    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(700, start);
    osc.frequency.exponentialRampToValueAtTime(220, end);

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.55, start + 0.015);
    gain.gain.setValueAtTime(0.55, end - 0.03);
    gain.gain.linearRampToValueAtTime(0, end);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

/**
 * Peace Mode — A-major chord resolution (4 sine voices staggered 100ms apart).
 * A3 (220 Hz), C#4 (277 Hz), E4 (330 Hz), A4 (440 Hz) — warm, consonant, resolved.
 * Long 2.5-second decay on all voices.
 */
function _playPeaceTone(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  // A major chord: A3, C#4, E4, A4
  const chord = [220, 277.18, 329.63, 440];

  chord.forEach((freq, i) => {
    const start = ctx.currentTime + i * 0.10;
    const osc   = ctx.createOscillator();
    const gain  = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.28, start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 2.5);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 2.6);
  });
}

// ── Spatial Audio Layer ──────────────────────────────────────────────────────
//
// Three continuous ambient layers:
//   1. Tension drone  — two detuned 40 Hz triangle oscillators (sub-bass) with a
//      slow 0.08 Hz LFO tremolo. Pitch tracks war-score (40–100 Hz). Sounds like
//      a deep rumble you feel rather than a hum you hear.
//   2. Ambient chatter — bandpass-filtered noise clicks, rate scales with
//      recent breaking-news event count (1/8s → 1/1s)
//   3. Escalation pings — three-tone descending sine on each wm:breaking-news
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

let _masterGain:    GainNode       | null = null;
let _droneOsc:      OscillatorNode | null = null;
let _droneOsc2:     OscillatorNode | null = null; // second detuned oscillator
let _droneLfo:      OscillatorNode | null = null; // LFO for tremolo
let _droneLfoGain:  GainNode       | null = null; // LFO depth scaler
let _droneGainNode: GainNode       | null = null;
let _ambientTimer:  ReturnType<typeof setTimeout> | null = null;
let _idleTimer:     ReturnType<typeof setTimeout> | null = null;
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
  // Drone defaults OFF (must be explicitly enabled). Ambient & pings default ON.
  if (layer === 'drone') return localStorage.getItem(key) === '1';
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

  // Low power mode: stop all spatial layers when enabled, restart when disabled
  document.addEventListener('wm:low-power-changed', ((e: CustomEvent) => {
    const enabled = e.detail as boolean;
    if (enabled) {
      _stopDrone();
      _cancelChatter();
    } else {
      if (isSpatialLayerEnabled('drone')   && !isMuted()) _startDrone();
      if (isSpatialLayerEnabled('ambient') && !isMuted()) _scheduleChatter();
    }
  }) as EventListener);

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
//
// Two detuned triangle oscillators at ~40 Hz (sub-bass) with a slow 0.08 Hz
// LFO tremolo. At 40 Hz you feel the pulse rather than hearing a steady hum.
// Pitch tracks war-score: 40 Hz (peace) → 100 Hz (max threat).

function _startDrone(): void {
  if (_droneOsc) return;
  const ctx = _getCtx();
  if (!ctx) return;
  _ensureMasterGain(ctx);
  if (!_masterGain) return;

  const baseFreq = 40 + _warScore * 0.6; // 40–100 Hz

  // Primary oscillator
  _droneOsc = ctx.createOscillator();
  _droneOsc.type = 'triangle';
  _droneOsc.frequency.setValueAtTime(baseFreq, ctx.currentTime);

  // Second oscillator ~0.5% detuned — creates a slow natural beating effect
  _droneOsc2 = ctx.createOscillator();
  _droneOsc2.type = 'triangle';
  _droneOsc2.frequency.setValueAtTime(baseFreq * 1.005, ctx.currentTime);

  // Drone gain — base level, will be modulated by LFO
  _droneGainNode = ctx.createGain();
  _droneGainNode.gain.setValueAtTime(0.30, ctx.currentTime);

  // LFO tremolo: 0.08 Hz (12.5-second cycle) — slow, breathing pulse
  _droneLfo = ctx.createOscillator();
  _droneLfo.type = 'sine';
  _droneLfo.frequency.setValueAtTime(0.08, ctx.currentTime);

  _droneLfoGain = ctx.createGain();
  _droneLfoGain.gain.setValueAtTime(0.20, ctx.currentTime); // ±0.20 tremolo depth

  // LFO modulates drone gain AudioParam directly
  _droneLfo.connect(_droneLfoGain);
  _droneLfoGain.connect(_droneGainNode.gain);

  // Slow fade-in envelope (8 seconds) via a pre-gain
  const fadeIn = ctx.createGain();
  fadeIn.gain.setValueAtTime(0, ctx.currentTime);
  fadeIn.gain.linearRampToValueAtTime(1, ctx.currentTime + 8);

  _droneOsc.connect(fadeIn);
  _droneOsc2.connect(fadeIn);
  fadeIn.connect(_droneGainNode);
  _droneGainNode.connect(_masterGain);

  _droneOsc.start();
  _droneOsc2.start();
  _droneLfo.start();
}

function _stopDrone(): void {
  const ctx = _getCtx();
  if (ctx && _droneGainNode) {
    _droneGainNode.gain.cancelScheduledValues(ctx.currentTime);
    _droneGainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
  }
  const osc  = _droneOsc;
  const osc2 = _droneOsc2;
  const lfo  = _droneLfo;
  _droneOsc     = null;
  _droneOsc2    = null;
  _droneLfo     = null;
  _droneLfoGain = null;
  _droneGainNode = null;
  setTimeout(() => {
    try { osc?.stop();  } catch { /* already stopped */ }
    try { osc2?.stop(); } catch { /* already stopped */ }
    try { lfo?.stop();  } catch { /* already stopped */ }
  }, 2000);
}

function _updateDronePitch(): void {
  if (!_droneOsc) return;
  const ctx = _getCtx();
  if (!ctx) return;
  const baseFreq = 40 + _warScore * 0.6;
  _droneOsc.frequency.setTargetAtTime(baseFreq, ctx.currentTime, 3.0);
  _droneOsc2?.frequency.setTargetAtTime(baseFreq * 1.005, ctx.currentTime, 3.0);
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
  const durS   = 0.04 + Math.random() * 0.06; // 40–100 ms noise burst
  const bufLen = Math.ceil(ctx.sampleRate * durS);
  const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data   = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const bpf = ctx.createBiquadFilter();
  bpf.type = 'bandpass';
  bpf.frequency.setValueAtTime(1200 + Math.random() * 2000, ctx.currentTime); // 1.2–3.2 kHz
  bpf.Q.setValueAtTime(6 + Math.random() * 6, ctx.currentTime); // sharper, more radio-like

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.18, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durS);

  src.connect(bpf);
  bpf.connect(g);
  g.connect(_masterGain);
  src.start();
}

// ── Escalation pings ──────────────────────────────────────────────────────────
//
// Critical: three descending tones 1100 → 800 → 580 Hz at 0.38 gain.
// High:     two descending tones   750 → 520 Hz at 0.24 gain.

function _playEscalationPing(level?: 'critical' | 'high'): void {
  const ctx = _getCtx();
  if (!ctx) return;
  _ensureMasterGain(ctx);
  if (!_masterGain) return;

  const isCritical = level === 'critical';
  const freqs    = isCritical ? [1100, 800, 580] : [750, 520];
  const peakGain = isCritical ? 0.38 : 0.24;

  (freqs as number[]).forEach((freq, i) => {
    const t = ctx.currentTime + i * 0.15;
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peakGain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    osc.connect(g);
    g.connect(_masterGain!);
    osc.start(t);
    osc.stop(t + 0.30);
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
