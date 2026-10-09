// HeyGen LiveAvatar: a talking head that says exactly the anchor's lines.
// The server mints a one-session token (the API key never reaches the
// browser); the SDK is bundled locally (public/vendor/liveavatar.js).
//
// Failure is never fatal: if the session cannot start, drops, or a line
// times out, the caller falls back to the globe and the voice.

let sdk = null;
let session = null;
let videoEl = null;
let ready = false;
let wanted = false;
let onChange = () => {};
let speakDone = null;

function setReady(value) {
  ready = value;
  onChange({ ready, wanted });
}

export function isActive() {
  return wanted && ready;
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

async function connect() {
  const { LiveAvatarSession, SessionEvent, AgentEventsEnum } = await load();
  const res = await fetch('/api/avatar/token', { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `token HTTP ${res.status}`);
  const s = new LiveAvatarSession(body.session_token, { autoKeepAlive: true, voiceChat: { defaultMuted: true } });
  const streamReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('avatar stream timed out')), 25_000);
    s.on(SessionEvent.SESSION_STREAM_READY, () => {
      clearTimeout(timer);
      s.attach(videoEl);
      videoEl.muted = false;
      videoEl.play?.().catch(() => {});
      resolve();
    });
  });
  // LiveAvatar speaks the context's opening line when a session starts; the
  // desk's own lines wait for it, so they don't end on its speak_ended.
  let openingDone;
  const opening = new Promise((resolve) => { openingDone = resolve; });
  s.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => { openingDone(); speakDone?.(); });
  s.on(SessionEvent.SESSION_DISCONNECTED, () => {
    if (session !== s) return;
    session = null;
    setReady(false);
    speakDone?.();
    // Sessions can be time-capped: reconnect quietly while the avatar is wanted.
    if (wanted) setTimeout(() => { if (wanted && !session) start(videoEl).catch(() => {}); }, 500);
  });
  session = s;
  await s.start();
  await streamReady;
  await Promise.race([opening, new Promise((r) => setTimeout(r, 5_000))]);
  setReady(true);
}

/** Starts (or restarts) the avatar. Resolves true when it is on screen. */
export async function start(video) {
  videoEl = video;
  wanted = true;
  onChange({ ready, wanted, connecting: true });
  try {
    if (!session) await connect();
    return true;
  } catch (error) {
    console.warn('[avatar] could not start:', error.message);
    session = null;
    wanted = false; // back on the globe; A tries again
    setReady(false);
    onChange({ ready: false, wanted, error: error.message });
    return false;
  }
}

/** Switches back to the globe. The session is closed so it stops costing credits. */
export async function stop() {
  wanted = false;
  const s = session;
  session = null;
  setReady(false);
  try { await s?.stop(); } catch { /* already gone */ }
}

export function interrupt() {
  try { session?.interrupt(); } catch { /* not connected */ }
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

/**
 * Speaks `text` exactly (LiveAvatar `repeat`). Progress is reported per chunk.
 * Throws if the avatar is not connected, so the caller can fall back.
 */
export async function speak(text, onProgress, cancelled) {
  if (!isActive()) throw new Error('avatar not connected');
  const parts = chunks(text);
  let spoken = 0;
  for (const part of parts) {
    if (cancelled()) return;
    if (!isActive()) throw new Error('avatar dropped');
    await new Promise((resolve) => {
      // Generous ceiling: ~65 ms per character, plus start-up slack.
      const timer = setTimeout(resolve, part.length * 65 + 6000);
      speakDone = () => { clearTimeout(timer); speakDone = null; resolve(); };
      session.repeat(part);
    });
    spoken += part.length + 1;
    onProgress(Math.min(1, spoken / text.length));
  }
}
