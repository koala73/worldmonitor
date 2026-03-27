/**
 * Sound Manager — Mode Transition & Spatial Alert Audio
 *
 * All sounds are synthesized procedurally with the Web Audio API. No audio files.
 *
 * Mode transition sounds:
 *   War:      military two-tone pulse (440/880 Hz, 3 pairs)
 *   Finance:  Bloomberg-style broadcast chime (C5 → G5)
 *   Peace:    soft resolved fourth (G4 → C5)
 *   Disaster: EAS dual-tone attention signal (853/960 Hz, 3 bursts)
 *   Ghost:    descending electronic sweep (800 → 120 Hz)
 *
 * Continuous spatial layers (all feed through _masterGain):
 *   drone     — sub-bass triangle rumble, war-score-driven pitch (40–100 Hz)
 *   ambient   — bandpass noise chatter, density scales with breaking news
 *   pings     — escalation tones on breaking alerts
 *   radar     — sonar-style sweep tick (active in War/Ghost modes)
 *   ticker    — teletype micro-click stream (active in Finance mode)
 *   ghost     — eerie 28 Hz sawtooth hum with slow tremolo (Ghost mode only)
 *
 * One-shot utility sounds (exported for callers):
 *   playUiClick(type)   — panel open/close UI feedback
 *   playDataTick(level) — data ingestion pulse (info/warning/critical)
 *   playSonarPing()     — map event ping
 *   playGeigerTick()    — radiation panel click
 *
 * localStorage keys:
 *   wm-sound-muted       '0'|'1'        global mute (default 0)
 *   wm-spatial-volume    '0.00'–'1.00'  master volume (default 0.50)
 *   wm-spatial-ambient   '0'|'1'        default 1
 *   wm-spatial-drone     '0'|'1'        default 0 (OFF — felt, not heard)
 *   wm-spatial-pings     '0'|'1'        default 1
 *   wm-spatial-radar     '0'|'1'        default 1
 *   wm-spatial-ticker    '0'|'1'        default 1
 *   wm-spatial-ghost     '0'|'1'        default 1
 *   wm-sound-ui          '0'|'1'        UI click sounds (default 1)
 *   wm-sound-data        '0'|'1'        data ingestion ticks (default 1)
 */

import type { AppMode, ModeChangedDetail } from '@/services/mode-manager';

const MUTE_KEY           = 'wm-sound-muted';
const UI_SOUND_KEY       = 'wm-sound-ui';
const DATA_SOUND_KEY     = 'wm-sound-data';

let _ctx: AudioContext | null = null;
let _initialized = false;
let _currentMode: AppMode = 'peace';

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
      _currentMode = mode;
      _playModeSound(mode);
      _onModeChangedLayers(mode, prev);
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
  _stopRadar();
  _cancelTicker();
  _stopGhostDrone();

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
    case 'ghost':    return _playGhostActivate();
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
const SPATIAL_RADAR_KEY   = 'wm-spatial-radar';
const SPATIAL_TICKER_KEY  = 'wm-spatial-ticker';
const SPATIAL_GHOST_KEY   = 'wm-spatial-ghost';
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

// ── New layer state ────────────────────────────────────────────────────────────
let _radarTimer:    ReturnType<typeof setTimeout> | null = null;
let _tickerTimer:   ReturnType<typeof setTimeout> | null = null;
let _ghostDroneOsc: OscillatorNode | null = null;
let _ghostDroneOsc2:OscillatorNode | null = null;
let _ghostLfo:      OscillatorNode | null = null;
let _ghostLfoGain:  GainNode       | null = null;
let _ghostGainNode: GainNode       | null = null;

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

export type SpatialLayer = 'ambient' | 'drone' | 'pings' | 'radar' | 'ticker' | 'ghost';

/** Whether a spatial layer is enabled. Drone defaults OFF; all others default ON. */
export function isSpatialLayerEnabled(layer: SpatialLayer): boolean {
  const key = _spatialKey(layer);
  if (layer === 'drone') return localStorage.getItem(key) === '1';
  return localStorage.getItem(key) !== '0';
}

/** Enable or disable a spatial layer and apply immediately. */
export function setSpatialLayerEnabled(layer: SpatialLayer, enabled: boolean): void {
  localStorage.setItem(_spatialKey(layer), enabled ? '1' : '0');
  switch (layer) {
    case 'drone':   enabled ? _startDrone()      : _stopDrone();      break;
    case 'ambient': enabled ? _scheduleChatter() : _cancelChatter();  break;
    case 'radar':   enabled ? _scheduleRadar()   : _stopRadar();      break;
    case 'ticker':  enabled ? _scheduleTicker()  : _cancelTicker();   break;
    case 'ghost':   enabled ? _startGhostDrone() : _stopGhostDrone(); break;
  }
}

/** Whether UI click sounds are enabled. */
export function isUiSoundEnabled(): boolean {
  return localStorage.getItem(UI_SOUND_KEY) !== '0';
}

/** Toggle UI click sounds on/off. */
export function setUiSoundEnabled(enabled: boolean): void {
  localStorage.setItem(UI_SOUND_KEY, enabled ? '1' : '0');
}

/** Whether data ingestion tick sounds are enabled. */
export function isDataSoundEnabled(): boolean {
  return localStorage.getItem(DATA_SOUND_KEY) !== '0';
}

/** Toggle data tick sounds on/off. */
export function setDataSoundEnabled(enabled: boolean): void {
  localStorage.setItem(DATA_SOUND_KEY, enabled ? '1' : '0');
}

function _spatialKey(layer: SpatialLayer): string {
  switch (layer) {
    case 'ambient': return SPATIAL_AMBIENT_KEY;
    case 'drone':   return SPATIAL_DRONE_KEY;
    case 'pings':   return SPATIAL_PINGS_KEY;
    case 'radar':   return SPATIAL_RADAR_KEY;
    case 'ticker':  return SPATIAL_TICKER_KEY;
    case 'ghost':   return SPATIAL_GHOST_KEY;
  }
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
      _stopRadar();
      _cancelTicker();
      _stopGhostDrone();
    } else if (!isMuted()) {
      if (isSpatialLayerEnabled('drone'))   _startDrone();
      if (isSpatialLayerEnabled('ambient')) _scheduleChatter();
      _onModeChangedLayers(_currentMode, _currentMode);
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
    if (!isMuted()) {
      if (isSpatialLayerEnabled('drone'))   _startDrone();
      if (isSpatialLayerEnabled('ambient')) _scheduleChatter();
      // Mode-specific layers — seed from current mode
      _onModeChangedLayers(_currentMode, _currentMode);
    }
  };
  document.addEventListener('click',   _startAfterGesture, { once: true });
  document.addEventListener('keydown', _startAfterGesture, { once: true });
}

// ── Mode-driven layer switching ───────────────────────────────────────────────

function _onModeChangedLayers(mode: AppMode, prev: AppMode): void {
  if (isMuted()) return;

  const wasWarOrGhost = prev === 'war' || prev === 'ghost';
  const isWarOrGhost  = mode === 'war' || mode === 'ghost';
  const wasFinance    = prev === 'finance';
  const isFinance     = mode === 'finance';
  const wasGhost      = prev === 'ghost';
  const isGhost       = mode === 'ghost';

  // Radar: active in War + Ghost
  if (isWarOrGhost && !wasWarOrGhost && isSpatialLayerEnabled('radar')) _scheduleRadar();
  if (!isWarOrGhost && wasWarOrGhost) _stopRadar();

  // Stock ticker: active in Finance
  if (isFinance && !wasFinance && isSpatialLayerEnabled('ticker')) _scheduleTicker();
  if (!isFinance && wasFinance) _cancelTicker();

  // Ghost drone: active in Ghost only
  if (isGhost && !wasGhost && isSpatialLayerEnabled('ghost')) _startGhostDrone();
  if (!isGhost && wasGhost) _stopGhostDrone();
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

// ══════════════════════════════════════════════════════════════════════════════
// Ghost Mode activation sound
// ══════════════════════════════════════════════════════════════════════════════
//
// A descending electronic sweep (800 → 120 Hz) with a slow de-tuned harmonic.
// Signals stealth mode activation — cinematic, not alarming.

function _playGhostActivate(): void {
  const ctx = _getCtx();
  if (!ctx) return;

  const t0 = ctx.currentTime;

  // Primary descending sweep
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(800, t0);
  osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.9);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.30, t0 + 0.04);
  g.gain.setValueAtTime(0.30, t0 + 0.55);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.05);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + 1.1);

  // Soft de-tuned second harmonic for depth
  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(804, t0);
  osc2.frequency.exponentialRampToValueAtTime(122, t0 + 0.9);

  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0, t0);
  g2.gain.linearRampToValueAtTime(0.12, t0 + 0.05);
  g2.gain.exponentialRampToValueAtTime(0.001, t0 + 1.10);
  osc2.connect(g2);
  g2.connect(ctx.destination);
  osc2.start(t0); osc2.stop(t0 + 1.15);

  // Brief filtered noise burst at the start (atmospheric texture)
  const nBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.18), ctx.sampleRate);
  const nd = nBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const nSrc = ctx.createBufferSource(); nSrc.buffer = nBuf;
  const nF = ctx.createBiquadFilter(); nF.type = 'bandpass'; nF.frequency.value = 3200; nF.Q.value = 0.8;
  const nG = ctx.createGain();
  nG.gain.setValueAtTime(0.07, t0);
  nG.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
  nSrc.connect(nF).connect(nG).connect(ctx.destination);
  nSrc.start(t0);
}

// ══════════════════════════════════════════════════════════════════════════════
// Radar sweep spatial layer  (War + Ghost modes)
// ══════════════════════════════════════════════════════════════════════════════
//
// A sonar-style ping repeating every 2.8 s (War) or 4.5 s (Ghost).
// Two-component: a clean 1400 Hz sine with exponential decay, plus a faint
// 2800 Hz harmonic that makes it sparkle. Routes through _masterGain.

function _scheduleRadar(): void {
  if (_radarTimer !== null) return;
  _fireRadarPing();
}

function _stopRadar(): void {
  if (_radarTimer !== null) { clearTimeout(_radarTimer); _radarTimer = null; }
}

function _fireRadarPing(): void {
  if (!isSpatialLayerEnabled('radar') || isMuted()) { _radarTimer = null; return; }
  const ctx = _getCtx();
  if (!ctx) { _radarTimer = null; return; }
  _ensureMasterGain(ctx);
  if (!_masterGain) { _radarTimer = null; return; }

  const t = ctx.currentTime;

  // Primary ping tone — 1400 Hz
  const o1 = ctx.createOscillator(); o1.type = 'sine';
  o1.frequency.setValueAtTime(1400, t);
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0, t);
  g1.gain.linearRampToValueAtTime(0.22, t + 0.003);
  g1.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
  o1.connect(g1).connect(_masterGain);
  o1.start(t); o1.stop(t + 0.58);

  // Sparkle harmonic — 2800 Hz at 35% gain
  const o2 = ctx.createOscillator(); o2.type = 'sine';
  o2.frequency.setValueAtTime(2800, t);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0, t);
  g2.gain.linearRampToValueAtTime(0.08, t + 0.003);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.30);
  o2.connect(g2).connect(_masterGain);
  o2.start(t); o2.stop(t + 0.33);

  // Interval: shorter in War (more active), longer in Ghost (eerie spacing)
  const intervalMs = _currentMode === 'ghost' ? 4400 + Math.random() * 600
                                              : 2600 + Math.random() * 400;
  _radarTimer = setTimeout(_fireRadarPing, intervalMs);
}

// ══════════════════════════════════════════════════════════════════════════════
// Stock ticker spatial layer  (Finance mode)
// ══════════════════════════════════════════════════════════════════════════════
//
// Rapid micro-clicks mimicking a teletype or trading terminal.
// High-frequency noise bursts (3–5 kHz) at randomised short intervals.

function _scheduleTicker(): void {
  if (_tickerTimer !== null) return;
  _fireTickerClick();
}

function _cancelTicker(): void {
  if (_tickerTimer !== null) { clearTimeout(_tickerTimer); _tickerTimer = null; }
}

function _fireTickerClick(): void {
  if (!isSpatialLayerEnabled('ticker') || isMuted()) { _tickerTimer = null; return; }
  const ctx = _getCtx();
  if (!ctx) { _tickerTimer = null; return; }
  _ensureMasterGain(ctx);
  if (!_masterGain) { _tickerTimer = null; return; }

  // 6–14 ms burst of noise through a tight high-frequency bandpass
  const durS  = 0.006 + Math.random() * 0.008;
  const buf   = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * durS), ctx.sampleRate);
  const data  = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource(); src.buffer = buf;
  const bpf = ctx.createBiquadFilter();
  bpf.type = 'bandpass';
  bpf.frequency.setValueAtTime(3000 + Math.random() * 2000, ctx.currentTime);
  bpf.Q.setValueAtTime(8 + Math.random() * 6, ctx.currentTime);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.12, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durS);

  src.connect(bpf).connect(g).connect(_masterGain);
  src.start();

  const nextMs = 120 + Math.random() * 280; // 120–400 ms between ticks
  _tickerTimer = setTimeout(_fireTickerClick, nextMs);
}

// ══════════════════════════════════════════════════════════════════════════════
// Ghost ambient drone  (Ghost mode only)
// ══════════════════════════════════════════════════════════════════════════════
//
// Two sawtooth oscillators at 28 Hz through a lowpass filter at 90 Hz — removes
// harsh harmonics, leaving only a dark sub-bass presence. Very slow 0.035 Hz
// LFO tremolo (28-second cycle) — barely breathing. Distinct from the war drone
// (40–100 Hz triangle, 0.08 Hz tremolo, fast pitch modulation).

function _startGhostDrone(): void {
  if (_ghostDroneOsc) return;
  const ctx = _getCtx();
  if (!ctx) return;
  _ensureMasterGain(ctx);
  if (!_masterGain) return;

  const BASE = 28; // Hz

  _ghostDroneOsc = ctx.createOscillator();
  _ghostDroneOsc.type = 'sawtooth';
  _ghostDroneOsc.frequency.setValueAtTime(BASE, ctx.currentTime);

  _ghostDroneOsc2 = ctx.createOscillator();
  _ghostDroneOsc2.type = 'sawtooth';
  _ghostDroneOsc2.frequency.setValueAtTime(BASE * 1.007, ctx.currentTime);

  // Lowpass to remove harsh sawtooth edge — only the dark sub-bass survives
  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass'; lpf.frequency.value = 90;

  _ghostGainNode = ctx.createGain();
  _ghostGainNode.gain.setValueAtTime(0.28, ctx.currentTime);

  // Very slow LFO — 0.035 Hz = 28-second cycle
  _ghostLfo = ctx.createOscillator();
  _ghostLfo.type = 'sine';
  _ghostLfo.frequency.setValueAtTime(0.035, ctx.currentTime);

  _ghostLfoGain = ctx.createGain();
  _ghostLfoGain.gain.setValueAtTime(0.18, ctx.currentTime);
  _ghostLfo.connect(_ghostLfoGain);
  _ghostLfoGain.connect(_ghostGainNode.gain);

  // 10-second fade in — slow and ominous
  const fadeIn = ctx.createGain();
  fadeIn.gain.setValueAtTime(0, ctx.currentTime);
  fadeIn.gain.linearRampToValueAtTime(1, ctx.currentTime + 10);

  _ghostDroneOsc.connect(lpf);
  _ghostDroneOsc2.connect(lpf);
  lpf.connect(fadeIn);
  fadeIn.connect(_ghostGainNode);
  _ghostGainNode.connect(_masterGain);

  _ghostDroneOsc.start(); _ghostDroneOsc2.start(); _ghostLfo.start();
}

function _stopGhostDrone(): void {
  const ctx = _getCtx();
  if (ctx && _ghostGainNode) {
    _ghostGainNode.gain.cancelScheduledValues(ctx.currentTime);
    _ghostGainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.8);
  }
  const o1 = _ghostDroneOsc; const o2 = _ghostDroneOsc2;
  const lfo = _ghostLfo; const lfoG = _ghostLfoGain; const gN = _ghostGainNode;
  _ghostDroneOsc = null; _ghostDroneOsc2 = null;
  _ghostLfo = null; _ghostLfoGain = null; _ghostGainNode = null;
  setTimeout(() => {
    try { o1?.disconnect(); o1?.stop(); } catch { /* already stopped */ }
    try { o2?.disconnect(); o2?.stop(); } catch { /* already stopped */ }
    try { lfo?.disconnect(); lfo?.stop(); } catch { /* already stopped */ }
    try { lfoG?.disconnect(); } catch { /* already disconnected */ }
    try { gN?.disconnect(); } catch { /* already disconnected */ }
  }, 2500);
}

// ══════════════════════════════════════════════════════════════════════════════
// One-shot utility sounds  (exported for component use)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Subtle UI click for panel interactions.
 * 'open': crisp 2200 Hz transient.  'close': softer 1600 Hz transient.
 * Routes directly to ctx.destination — independent of spatial volume.
 */
export function playUiClick(type: 'open' | 'close' = 'open'): void {
  if (isMuted() || !isUiSoundEnabled()) return;
  const ctx = _getCtx();
  if (!ctx) return;

  const freq  = type === 'open' ? 2200 : 1600;
  const peak  = type === 'open' ? 0.055 : 0.040;
  const decay = type === 'open' ? 0.065 : 0.055;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator(); osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  osc.connect(g).connect(ctx.destination);
  osc.start(t); osc.stop(t + decay + 0.01);

  // Short high-frequency noise transient for the "click" character
  const nDur = 0.008;
  const nBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * nDur), ctx.sampleRate);
  const nd = nBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const nSrc = ctx.createBufferSource(); nSrc.buffer = nBuf;
  const nF = ctx.createBiquadFilter(); nF.type = 'highpass';
  nF.frequency.value = type === 'open' ? 4500 : 3200;
  const nG = ctx.createGain();
  nG.gain.setValueAtTime(0.035, t);
  nG.gain.exponentialRampToValueAtTime(0.001, t + nDur);
  nSrc.connect(nF).connect(nG).connect(ctx.destination);
  nSrc.start(t);
}

/**
 * Data ingestion tick — plays when panels receive new data.
 *   'info':     quiet 2800 Hz blip
 *   'warning':  two-tone 1800 → 1200 Hz descending chirp
 *   'critical': bright sawtooth burst through bandpass — sharp and urgent
 */
export function playDataTick(level: 'info' | 'warning' | 'critical' = 'info'): void {
  if (isMuted() || !isDataSoundEnabled()) return;
  const ctx = _getCtx();
  if (!ctx) return;
  _ensureMasterGain(ctx);
  if (!_masterGain) return;

  const t = ctx.currentTime;

  if (level === 'info') {
    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(2800, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.055, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    osc.connect(g).connect(_masterGain);
    osc.start(t); osc.stop(t + 0.08);

  } else if (level === 'warning') {
    // Two-tone descending: 1800 → 1200 Hz
    for (const [freq, start, endFreq, peak] of [
      [1800, 0.00, 1400, 0.10] as [number, number, number, number],
      [1200, 0.09, 900,  0.08] as [number, number, number, number],
    ]) {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + start);
      osc.frequency.exponentialRampToValueAtTime(endFreq, t + start + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + start);
      g.gain.linearRampToValueAtTime(peak, t + start + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t + start + 0.10);
      osc.connect(g).connect(_masterGain);
      osc.start(t + start); osc.stop(t + start + 0.12);
    }

  } else {
    // Critical: bright sawtooth through bandpass — punchy, attention-grabbing
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1100, t);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.10);
    const bpf = ctx.createBiquadFilter(); bpf.type = 'bandpass';
    bpf.frequency.value = 1800; bpf.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(bpf).connect(g).connect(_masterGain);
    osc.start(t); osc.stop(t + 0.16);
  }
}

/**
 * Sonar ping — for new map events (cyber, ADS-B, seismic).
 * Clean 680 Hz sine with long exponential tail and a faint 1360 Hz harmonic.
 */
export function playSonarPing(): void {
  if (isMuted()) return;
  const ctx = _getCtx();
  if (!ctx) return;
  _ensureMasterGain(ctx);
  if (!_masterGain) return;

  const t = ctx.currentTime;

  // Primary 680 Hz — sustained attack + clean decay
  const o1 = ctx.createOscillator(); o1.type = 'sine';
  o1.frequency.setValueAtTime(680, t);
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0, t);
  g1.gain.linearRampToValueAtTime(0.28, t + 0.005);
  g1.gain.setValueAtTime(0.28, t + 0.018);
  g1.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
  o1.connect(g1).connect(_masterGain);
  o1.start(t); o1.stop(t + 0.58);

  // Faint 1360 Hz octave harmonic
  const o2 = ctx.createOscillator(); o2.type = 'sine';
  o2.frequency.setValueAtTime(1360, t);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0, t);
  g2.gain.linearRampToValueAtTime(0.10, t + 0.005);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  o2.connect(g2).connect(_masterGain);
  o2.start(t); o2.stop(t + 0.30);
}

/**
 * Geiger counter click — for radiation panel.
 * A single very-short noise burst through a highpass filter.
 * Call repeatedly on a Poisson-distributed timer for authenticity.
 */
export function playGeigerTick(): void {
  if (isMuted()) return;
  const ctx = _getCtx();
  if (!ctx) return;
  _ensureMasterGain(ctx);
  if (!_masterGain) return;

  const durS = 0.004 + Math.random() * 0.006; // 4–10 ms
  const buf  = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * durS), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource(); src.buffer = buf;
  const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 5500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.25 + Math.random() * 0.15, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durS);

  src.connect(hpf).connect(g).connect(_masterGain);
  src.start();
}

/**
 * Breaking-news / intelligence alert ping — replaces the base64 WAV placeholder.
 * A bright three-component tone: sine fundamental + two harmonics + noise snap.
 */
export function playAlertPing(): void {
  if (isMuted()) return;
  const ctx = _getCtx();
  if (!ctx) return;
  _ensureMasterGain(ctx);
  if (!_masterGain) return;

  const t = ctx.currentTime;

  // Fundamental 1050 Hz — clear and present
  const o1 = ctx.createOscillator(); o1.type = 'sine';
  o1.frequency.setValueAtTime(1050, t);
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0, t);
  g1.gain.linearRampToValueAtTime(0.32, t + 0.004);
  g1.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
  o1.connect(g1).connect(_masterGain);
  o1.start(t); o1.stop(t + 0.40);

  // Second harmonic 2100 Hz — adds sparkle
  const o2 = ctx.createOscillator(); o2.type = 'sine';
  o2.frequency.setValueAtTime(2100, t);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0, t);
  g2.gain.linearRampToValueAtTime(0.12, t + 0.003);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.20);
  o2.connect(g2).connect(_masterGain);
  o2.start(t); o2.stop(t + 0.22);

  // Noise transient — attack snap
  const nDur = 0.012;
  const nBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * nDur), ctx.sampleRate);
  const nd = nBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const nSrc = ctx.createBufferSource(); nSrc.buffer = nBuf;
  const nF = ctx.createBiquadFilter(); nF.type = 'bandpass'; nF.frequency.value = 3200; nF.Q.value = 1.2;
  const nG = ctx.createGain();
  nG.gain.setValueAtTime(0.10, t);
  nG.gain.exponentialRampToValueAtTime(0.001, t + nDur);
  nSrc.connect(nF).connect(nG).connect(_masterGain);
  nSrc.start(t);
}
