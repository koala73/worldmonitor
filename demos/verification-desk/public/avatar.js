// HeyGen LiveAvatar: a talking head that says exactly the anchor's lines.
// The server mints a one-session token (the API key never reaches the
// browser); the SDK is bundled locally (public/vendor/liveavatar.js).
//
// LiveAvatar caps a session's length by plan (120 s on the plan this was
// built on). So a second session warms up, muted and hidden, before the cap,
// and takes over between sentences: the audience sees one avatar.
//
// Failure is never fatal: if the session cannot start, drops, or a line
// times out, the caller falls back to the globe and the voice.

const WARM_AT_MS = 70_000;     // start the next session this long into the live one
const LAST_CHUNK_MS = 100_000; // never start a sentence on a session older than this
const STANDBY_WAIT_MS = 12_000;

let sdk = null;
let videos = [];
let live = null;     // { s, video, startedAt }
let standby = null;  // { video, ok, s?, startedAt?, promise }
let ready = false;
let wanted = false;
let speaking = false;
let warmTimer = null;
let onChange = () => {};
let speakDone = null;  // resolves the sentence in flight
let speakFail = null;  // rejects it: the session it was on is gone

function setReady(value) {
  ready = value;
  onChange({ ready, wanted });
}

// Inline !important beats the page's own "avatar on" opacity rules.
function hide(video, hidden) {
  if (hidden) video.style.setProperty('opacity', '0', 'important');
  else video.style.removeProperty('opacity');
}

export function isActive() {
  return wanted && ready && Boolean(live);
}

export function isWanted() {
  return wanted;
}

export function onStatus(cb) {
  onChange = cb;
}

async function load() {
  sdk ??= await import('/vendor/liveavatar.js');
  return sdk;
}

/** Opens one session on `video`. Resolves once its opening line is done. */
async function open(video, audible) {
  const { LiveAvatarSession, SessionEvent, AgentEventsEnum } = await load();
  const res = await fetch('/api/avatar/token', { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `token HTTP ${res.status}`);
  const s = new LiveAvatarSession(body.session_token, { autoKeepAlive: true, voiceChat: { defaultMuted: true } });
  const streamReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('avatar stream timed out')), 25_000);
    s.on(SessionEvent.SESSION_STREAM_READY, () => {
      clearTimeout(timer);
      s.attach(video);
      video.muted = !audible;
      video.play?.().catch(() => {});
      resolve();
    });
  });
  // LiveAvatar speaks the context's opening line when a session starts; the
  // desk's own lines wait for it, so they don't end on its speak_ended.
  let openingDone;
  const opening = new Promise((resolve) => { openingDone = resolve; });
  s.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
    openingDone();
    if (live?.s === s) speakDone?.();
  });
  s.on(SessionEvent.SESSION_DISCONNECTED, () => dropped(s));
  const startedAt = Date.now();
  try {
    await s.start();
    await streamReady;
  } catch (error) {
    s.stop().catch(() => {});
    throw error;
  }
  await Promise.race([opening, new Promise((r) => setTimeout(r, 5_000))]);
  return { s, video, startedAt };
}

function otherVideo() {
  return videos.find((v) => v !== live?.video && v !== standby?.video) ?? videos[0];
}

function scheduleWarm() {
  clearTimeout(warmTimer);
  if (!live) return;
  warmTimer = setTimeout(warm, Math.max(0, WARM_AT_MS - (Date.now() - live.startedAt)));
}

/** Warms the next session, muted and hidden. */
function warm() {
  if (standby || !wanted || !live) return;
  const video = otherVideo();
  hide(video, true);
  const slot = { video, ok: false };
  standby = slot;
  slot.promise = open(video, false).then((opened) => {
    if (standby !== slot || !wanted) { opened.s.stop().catch(() => {}); return; }
    Object.assign(slot, opened, { ok: true });
    if (!live || !speaking) promote(); // idle: swap now; speaking: between sentences
  }).catch((error) => {
    console.warn('[avatar] standby failed:', error.message);
    if (standby === slot) standby = null;
  });
}

/** The warmed session takes over; the old one is closed. */
function promote() {
  if (!standby?.ok) return false;
  const old = live;
  live = { s: standby.s, video: standby.video, startedAt: standby.startedAt };
  standby = null;
  live.video.muted = false;
  hide(live.video, false);
  if (old) {
    hide(old.video, true);
    if (old.s !== live.s) old.s.stop().catch(() => {});
  }
  setReady(true);
  scheduleWarm();
  return true;
}

function dropped(s) {
  if (standby?.s === s) { standby = null; return; }
  if (live?.s !== s) return;
  live = null;
  speakFail?.(new Error('avatar dropped'));
  if (!wanted) { setReady(false); return; }
  if (promote()) return;
  setReady(false);
  // No standby ready: reconnect quietly while the avatar is wanted.
  setTimeout(() => { if (wanted && !live) start(videos[0]).catch(() => {}); }, 500);
}

/** Starts (or restarts) the avatar. Resolves true when it is on screen. */
export async function start(video) {
  if (!videos.includes(video)) {
    const twin = video.cloneNode(false);
    twin.removeAttribute('id');
    hide(twin, true);
    video.after(twin);
    videos = [video, twin];
  }
  wanted = true;
  onChange({ ready, wanted, connecting: true });
  try {
    if (!live) {
      const target = otherVideo();
      const opened = await open(target, true);
      if (!wanted) { opened.s.stop().catch(() => {}); return false; }
      live = opened;
      for (const v of videos) hide(v, v !== target);
      setReady(true);
      scheduleWarm();
    }
    return true;
  } catch (error) {
    console.warn('[avatar] could not start:', error.message);
    live = null;
    wanted = false; // back on the globe; the switch key tries again
    setReady(false);
    onChange({ ready: false, wanted, error: error.message });
    return false;
  }
}

/** Switches back to the globe. Sessions are closed so they stop costing credits. */
export async function stop() {
  wanted = false;
  clearTimeout(warmTimer);
  speakDone?.(); // switched off mid-line: the line ends here, nothing else takes it over
  const sessions = [live?.s, standby?.s].filter(Boolean);
  live = null;
  standby = null;
  setReady(false);
  await Promise.all(sessions.map((s) => s.stop().catch(() => {})));
}

export function interrupt() {
  try { live?.s.interrupt(); } catch { /* not connected */ }
  speakDone?.();
}

// The avatar speaks best in short turns: sentences grouped up to ~280 chars.
function chunks(text) {
  const sentences = text.match(/[^.!?]+[.!?]+["”']?\s*|[^.!?]+$/g) ?? [text];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > 280 && cur) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Before a sentence: hand over to the warmed session, or wait for it near the cap. */
async function freshSession() {
  if (standby?.ok) { promote(); return; }
  if (live && Date.now() - live.startedAt > LAST_CHUNK_MS) {
    warm();
    await Promise.race([standby?.promise, new Promise((r) => setTimeout(r, STANDBY_WAIT_MS))]);
    promote();
  }
}

/**
 * Speaks `text` exactly (LiveAvatar `repeat`). Progress is reported per chunk.
 * Throws if the avatar is not connected, so the caller can fall back.
 */
export async function speak(text, onProgress, cancelled) {
  if (!isActive()) throw new Error('avatar not connected');
  const parts = chunks(text);
  let spoken = 0;
  speaking = true;
  try {
    for (const part of parts) {
      if (cancelled()) return;
      await freshSession();
      if (!isActive()) throw new Error('avatar dropped');
      await new Promise((resolve, reject) => {
        const settle = (fn) => (value) => { clearTimeout(timer); speakDone = null; speakFail = null; fn(value); };
        // Generous ceiling (~65 ms a character): a missed speak_ended on a live
        // session still counts as spoken, so the line is not said twice.
        const timer = setTimeout(() => settle(resolve)(), part.length * 65 + 6000);
        speakDone = settle(resolve);
        speakFail = settle(reject);
        live.s.repeat(part);
      });
      spoken += part.length + 1;
      onProgress(Math.min(1, spoken / text.length));
    }
  } finally {
    speaking = false;
  }
}
