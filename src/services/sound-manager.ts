/**
 * Sound Manager — Mode Transition & Alert Audio
 *
 * Synthesizes distinct sounds for each monitoring mode using the Web Audio API.
 * No audio files required — all sounds are generated procedurally.
 *
 * War Mode:      controlled military two-tone alert (440/880 Hz sine, 3 pulses)
 *                — authoritative and urgent without being panicked
 * Finance Mode:  clean two-note broadcast chime (523 → 783 Hz sine)
 *                — like a Bloomberg terminal or newsroom notification
 * Peace Mode:    soft resolved two-note tone (392 → 523 Hz sine)
 *                — clear status-cleared confirmation
 * Disaster Mode: EAS-style two-frequency attention signal (853/960 Hz sine, 3 pairs)
 *                — modeled on the US Emergency Alert System attention tone
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

// Stored handler references for cleanup (prevents event listener leaks)
let _modeChangedHandler: EventListener | null = null;
let _breakingNewsHandler: EventListener | null = null;
let _warScoreHandler: EventListener | null = null;
let _lowPowerHandler: EventListener | null = null;
let _idleMouseHandler: (() => void) | null = null;
let _idleKeyHandler: (() => void) | null = null;

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/** Initialize the sound manager — wire mode-change events. Call once from App.init(). */
export function initSoundManager(): void {
  if (_initialized) return;
  _initialized = true;

  _modeChangedHandler = ((e: CustomEvent<ModeChangedDetail>) => {
    const { mode, prev } = e.detail;
    if (mode !== prev) {
      _playModeSound(mode);
    }
  }) as EventListener;
  document.addEventListener('wm:mode-changed', _modeChangedHandler);

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

/** Tear down the sound manager — remove all event listeners and stop audio. */
export function destroySoundManager(): void {
  if (!_initialized) return;

  if (_modeChangedHandler) {
    document.removeEventListener('wm:mode-changed', _modeChangedHandler);
    _modeChangedHandler = null;
  }
  if (_breakingNewsHandler) {
    document.removeEventListener('wm:breaking-news', _breakingNewsHandler);
    _breakingNewsHandler = null;
  }
  if (_warScoreHandler) {
    document.removeEventListener('wm:war-score', _warScoreHandler);
    _warScoreHandler = null;
  }
  if (_lowPowerHandler) {
    document.removeEventListener('wm:low-power-changed', _lowPowerHandler);
    _lowPowerHandler = null;
  }
  document.removeEventListener('visibilitychange', _onVisibilityChange);

  if (_idleMouseHandler) {
    document.removeEventListener('mousemove', _idleMouseHandler);
    _idleMouseHandler = null;
  }
  if (_idleKeyHandler) {
    document.removeEventListener('keydown', _idleKeyHandler);
    _idleKeyHandler = null;
  }
  if (_idleTimer !== null) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }

  _stopDrone();
  _cancelChatter();

  if (_ctx) {
    void _ctx.close().catch(() => {});
    _ctx = null;
  }
  _masterGain = null;
  _initialized = false;
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
 * War Mode alarm — controlled military two-tone sine alert.
 * Three pulse pairs of 440 Hz (low) then 880 Hz (high) — authoritative,
 * urgent, clean. No harsh waveforms; modeled on operations-center tones.
 */
function _playWarAlarm(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  const PULSE_MS    = 140;  // duration of each individual tone
  const INNER_GAP   = 30;   // silence within a pair (between low and high)
  const PAIR_GAP_MS = 90;   // silence between pulse pairs
  const pairDurMs   = PULSE_MS * 2 + INNER_GAP + PAIR_GAP_MS;

  for (let i = 0; i < 3; i++) {
    const pairStart = ctx.currentTime + i * (pairDurMs / 1000);

    // Low tone — 440 Hz
    const t0   = pairStart;
    const osc0 = ctx.createOscillator();
    const g0   = ctx.createGain();
    osc0.type = 'sine';
    osc0.frequency.setValueAtTime(440, t0);
    g0.gain.setValueAtTime(0, t0);
    g0.gain.linearRampToValueAtTime(0.55, t0 + 0.006);
    g0.gain.setValueAtTime(0.55, t0 + PULSE_MS / 1000 - 0.015);
    g0.gain.linearRampToValueAtTime(0, t0 + PULSE_MS / 1000);
    osc0.connect(g0);
    g0.connect(ctx.destination);
    osc0.start(t0);
    osc0.stop(t0 + PULSE_MS / 1000 + 0.01);

    // High tone — 880 Hz
    const t1   = pairStart + (PULSE_MS + INNER_GAP) / 1000;
    const osc1 = ctx.createOscillator();
    const g1   = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, t1);
    g1.gain.setValueAtTime(0, t1);
    g1.gain.linearRampToValueAtTime(0.55, t1 + 0.006);
    g1.gain.setValueAtTime(0.55, t1 + PULSE_MS / 1000 - 0.015);
    g1.gain.linearRampToValueAtTime(0, t1 + PULSE_MS / 1000);
    osc1.connect(g1);
    g1.connect(ctx.destination);
    osc1.start(t1);
    osc1.stop(t1 + PULSE_MS / 1000 + 0.01);
  }
}

/**
 * Finance Mode chime — clean two-note broadcast chime (C5 → G5).
 * Short, precise sine tones with fast attack and natural decay.
 * Modeled on Bloomberg / network-news notification tones.
 */
function _playFinanceChime(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  // C5 (523 Hz) then G5 (783 Hz) — a perfect fifth interval
  const notes = [
    { freq: 523.25, start: 0.00, peakGain: 0.42, decay: 0.55 },
    { freq: 783.99, start: 0.22, peakGain: 0.38, decay: 1.30 },
  ];

  for (const { freq, start, peakGain, decay } of notes) {
    const t   = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peakGain, t + 0.007);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
}

/**
 * Disaster Mode alert — EAS-style two-frequency attention signal.
 * Three bursts of 853 Hz + 960 Hz played simultaneously, modeled on the
 * dual-tone that opens every US Emergency Alert System broadcast.
 * Sine waves only — alarming but not abrasive.
 */
function _playDisasterAlert(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  const BURST_MS = 380; // duration of each dual-tone burst
  const GAP_MS   = 110; // silence between bursts

  for (let i = 0; i < 3; i++) {
    const t = ctx.currentTime + i * ((BURST_MS + GAP_MS) / 1000);

    for (const freq of [853, 960]) {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.30, t + 0.010);
      g.gain.setValueAtTime(0.30, t + BURST_MS / 1000 - 0.020);
      g.gain.linearRampToValueAtTime(0, t + BURST_MS / 1000);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + BURST_MS / 1000 + 0.02);
    }
  }
}

/**
 * Peace Mode — soft two-note resolved tone (G4 → C5).
 * A perfect fourth interval: G4 (392 Hz) followed by C5 (523 Hz).
 * Gentle attack, long sine decay — a quiet, clear "status cleared" signal.
 */
function _playPeaceTone(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  // G4 → C5: a rising perfect fourth, classic "all clear" interval
  const notes = [
    { freq: 392,    start: 0.00, peakGain: 0.22, decay: 1.8 },
    { freq: 523.25, start: 0.20, peakGain: 0.22, decay: 2.2 },
  ];

  for (const { freq, start, peakGain, decay } of notes) {
    const t   = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peakGain, t + 0.020);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
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
  _breakingNewsHandler = ((e: CustomEvent) => {
    const { threatLevel } = e.detail as { threatLevel?: string };
    _recentBreakingCount = Math.min(_recentBreakingCount + 3, 20);
    setTimeout(() => { _recentBreakingCount = Math.max(0, _recentBreakingCount - 3); }, 5 * 60_000);
    if (isSpatialLayerEnabled('pings') && !isMuted()) {
      _playEscalationPing(threatLevel as 'critical' | 'high' | undefined);
    }
  }) as EventListener;
  document.addEventListener('wm:breaking-news', _breakingNewsHandler);

  // Drone pitch tracks war threat score
  _warScoreHandler = ((e: CustomEvent) => {
    _warScore = (e.detail as { score: number }).score ?? 0;
    _updateDronePitch();
  }) as EventListener;
  document.addEventListener('wm:war-score', _warScoreHandler);

  // Visibility mute/unmute
  document.addEventListener('visibilitychange', _onVisibilityChange);

  // Low power mode: stop all spatial layers when enabled, restart when disabled
  _lowPowerHandler = ((e: CustomEvent) => {
    const enabled = e.detail as boolean;
    if (enabled) {
      _stopDrone();
      _cancelChatter();
    } else {
      if (isSpatialLayerEnabled('drone')   && !isMuted()) _startDrone();
      if (isSpatialLayerEnabled('ambient') && !isMuted()) _scheduleChatter();
    }
  }) as EventListener;
  document.addEventListener('wm:low-power-changed', _lowPowerHandler);

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
  // Capture refs before nulling so the deferred cleanup can use them
  const osc  = _droneOsc;
  const osc2 = _droneOsc2;
  const lfo  = _droneLfo;
  const lfoG = _droneLfoGain;
  const dG   = _droneGainNode;
  _droneOsc      = null;
  _droneOsc2     = null;
  _droneLfo      = null;
  _droneLfoGain  = null;
  _droneGainNode = null;
  // Disconnect + stop after the gain has faded (2 s) so there's no click on cut.
  // Disconnecting severs AudioGraph references so nodes can be GC'd.
  setTimeout(() => {
    try { osc?.disconnect();  osc?.stop();  } catch { /* already stopped */ }
    try { osc2?.disconnect(); osc2?.stop(); } catch { /* already stopped */ }
    try { lfo?.disconnect();  lfo?.stop();  } catch { /* already stopped */ }
    try { lfoG?.disconnect(); } catch { /* already disconnected */ }
    try { dG?.disconnect();   } catch { /* already disconnected */ }
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
// Critical: three ascending tones 440 → 660 → 990 Hz at 0.40 gain.
// High:     two ascending tones   440 → 660 Hz at 0.28 gain.
// Ascending (not descending) — signals an event requiring attention, not a siren.

function _playEscalationPing(level?: 'critical' | 'high'): void {
  const ctx = _getCtx();
  if (!ctx) return;
  _ensureMasterGain(ctx);
  if (!_masterGain) return;

  const isCritical = level === 'critical';
  const freqs    = isCritical ? [440, 660, 990] : [440, 660];
  const peakGain = isCritical ? 0.40 : 0.28;

  freqs.forEach((freq, i) => {
    const t   = ctx.currentTime + i * 0.13;
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peakGain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(g);
    g.connect(_masterGain!);
    osc.start(t);
    osc.stop(t + 0.37);
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
  _idleMouseHandler = resetIdle;
  _idleKeyHandler = resetIdle;
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
