// Live WorldMonitor scenes for the stage deck (public/deck.html).
//
// The deck is a hand-researched, scripted show. These two scenes are the
// live part: "Live board" (today's WorldMonitor stories, split by its own
// coverage verdict) and "Live check" (a headline from the room, checked
// against WorldMonitor in real time). They use the deck's own components,
// voice, captions and avatar; every judgment comes from the desk server
// (/api/board, /api/grade), which calls WorldMonitor's code.
//
// Loaded as a module after the deck's scripts and before its boot, so it can
// register scenes and extend the keyboard. If the desk server is not running
// (deck opened as a file), this module does not load and the deck runs as-is.

import * as heygen from './avatar.js';

/* global addScene, SC, S, CONFIG, ORDER_ALL, DATA, ASSETS, Voice, SFX, h, esc, $, $$, countUp, dialSVG, toast, go, cur, updateHud, HELP */

const LIVE = { config: {}, board: null, boardError: null, result: null, n: 0, picks: [], pickSel: 0, timers: [] };
const at = (ms, f) => LIVE.timers.push(setTimeout(f, ms));
const clearTimers = () => { LIVE.timers.forEach(clearTimeout); LIVE.timers = []; };

/* ---------- narration: deck voice, ElevenLabs audio, or the HeyGen face ---------- */

function proportionalCaps(text, ms) {
  const parts = (text.match(/[^.!?]+[.!?]+["”’]?|[^.!?]+$/g) || [text]).map((s) => s.trim()).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  let t = 0;
  return parts.map((p) => { const d = (p.length / total) * ms; const c = [Math.round(t), Math.round(t + d), p]; t += d; return c; });
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
}

/** Registers `text` under a fresh narration id; with ElevenLabs it becomes "recorded" audio with timed captions. */
async function prepareNarration(prefix, text) {
  const id = `${prefix}_${++LIVE.n}`;
  DATA.say[id] = text;
  if (LIVE.config.tts === 'elevenlabs') {
    try {
      const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (res.status === 200) {
        const blob = await res.blob();
        const ac = Voice.ac();
        const buf = await ac.decodeAudioData(await blob.arrayBuffer());
        ASSETS.audio[id] = { src: await blobToDataUrl(blob), caps: proportionalCaps(text, buf.duration * 1000) };
      }
    } catch { /* the browser voice reads DATA.say[id] */ }
  }
  return id;
}

// HeyGen speaks any narration, including the deck's own recorded lines, when it is on.
const deckPlay = Voice.play;
const deckStop = Voice.stop;
let heygenRun = 0;
function showCaption(text) {
  const el = $('#caps');
  el.dataset.t = text;
  el.innerHTML = `<span class="who">${esc(CONFIG.voiceName)} · AI AVATAR</span>${esc(text)}<span class="bar"><i></i></span>`;
  el.classList.add('on');
}
// The deck's recorded lines introduce "an AI voice"; with the face on screen
// the same line is said by an avatar. Only the self-description changes.
const avatarWording = (t) => t.replace(/\ban AI voice\b/g, 'an AI avatar').replace(/\bAI voice\b/g, 'AI avatar');

Voice.play = async (id) => {
  if (!heygen.isActive() || !DATA.say[id]) return deckPlay(id);
  const text = avatarWording(DATA.say[id]);
  deckStop(true);
  const run = ++heygenRun;
  const sentences = text.match(/[^.!?]+[.!?]+["”’]?|[^.!?]+$/g) || [text];
  $('#avatar').classList.add('speaking');
  try {
    await heygen.speak(text, (p) => {
      if (run !== heygenRun) return;
      const i = Math.min(sentences.length - 1, Math.floor(p * sentences.length));
      showCaption(sentences[i].trim());
      const bar = $('#caps .bar i');
      if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    }, () => run !== heygenRun);
  } catch {
    if (run === heygenRun) deckPlay(id); // the face dropped: the deck's voice finishes the line
    return;
  }
  if (run === heygenRun) { $('#caps').classList.remove('on'); $('#avatar').classList.remove('speaking'); }
};
Voice.stop = (silent) => { heygenRun += 1; heygen.interrupt(); $('#caps')?.classList.remove('on'); return deckStop(silent); };

// A toggle while the avatar is still connecting (about eight seconds) would
// close the session the moment it opens; presses during that window are ignored.
let heygenBusy = false;
async function toggleHeygen() {
  const a = $('#avatar');
  if (heygenBusy) { toast('Avatar still connecting…'); return; }
  heygenBusy = true;
  try {
    if (heygen.isWanted()) {
      console.debug('[avatar] switch off requested');
      await heygen.stop();
      a.classList.remove('heygen');
      toast('WM Analyst: animated avatar');
      return;
    }
    if (!LIVE.config.avatar) { toast('Live avatar not configured: staying on the animated avatar'); return; }
    console.debug('[avatar] switch on requested');
    a.classList.add('heygen-wait');
    const ok = await heygen.start($('#avatar video'));
    a.classList.remove('heygen-wait');
    a.classList.toggle('heygen', ok);
    toast(ok ? 'Live avatar on (G to switch back)' : 'Live avatar unavailable: animated avatar');
  } finally {
    heygenBusy = false;
  }
}
/* ---------- data ---------- */

async function loadBoard(force = false) {
  if (LIVE.board && !force) return LIVE.board;
  try {
    const b = await fetch(`/api/board${force ? '?refresh=1' : ''}`).then((r) => r.json());
    if (b.error) throw new Error(b.error);
    LIVE.board = b;
    LIVE.boardError = null;
    LIVE.boardVoice = await prepareNarration('live_board', b.script);
  } catch (error) {
    LIVE.boardError = error.message;
  }
  return LIVE.board;
}

/**
 * Streams one check. Resolves as soon as WorldMonitor's verdict is in, so the
 * scene starts playing while the anchor's line is still being written; the
 * line arrives through `result.script` (a promise, null if it never comes).
 * Only one check streams at a time: opening a new one closes the last, and
 * the server stops that check at its next step.
 */
function grade(headline) {
  LIVE.es?.close();
  return new Promise((resolve) => {
    const es = new EventSource(`/api/grade?headline=${encodeURIComponent(headline)}`);
    LIVE.es = es;
    const acc = { headline };
    let settled = false;
    let scriptResolve;
    const script = new Promise((r) => { scriptResolve = r; });
    const settle = (value) => { if (settled) return; settled = true; resolve({ ...value, script }); };
    const close = (text) => { if (LIVE.es === es) LIVE.es = null; es.close(); scriptResolve(text); };
    es.addEventListener('match', (e) => { const d = JSON.parse(e.data); Object.assign(acc, { terms: d.terms, match: d.match, closest: d.closest }); });
    for (const step of ['who', 'when', 'numbers', 'money', 'verdict']) es.addEventListener(step, (e) => { acc[step] = JSON.parse(e.data); });
    es.addEventListener('verdict', () => settle(acc));
    es.addEventListener('done', (e) => { const d = JSON.parse(e.data); settle(d); close(d.script ?? null); });
    es.addEventListener('failure', (e) => { settle({ headline, failure: JSON.parse(e.data).message }); close(null); });
    es.onerror = () => { settle({ headline, failure: 'The desk server stopped answering.' }); close(null); };
  });
}

const STATE_CLS = { corroborated: 'ver', 'single-publisher': 'unv', 'tier4-only': 'mis', unknown: 'gap', 'not-found': 'gap', unreachable: 'gap' };
const BAND_COL = { high: 'var(--ver)', medium: 'var(--unv)', low: 'var(--fal)' };
const credBadge = (score, band) => (score == null ? '' : `<span class="badge cred-${band}">CRED ${score}</span>`);

/* ---------- scene: live board ---------- */

function boardPicks(b) {
  return [...b.supported.slice(0, 4), ...b.thin.slice(0, 3)];
}

addScene({
  id: 'liveboard', title: 'Live board', sub: 'Today on WorldMonitor', globe: 'dim', steps: 3, factual: true,
  voice: () => LIVE.boardVoice ?? null,
  build(root) {
    root.innerHTML = `<div class="head"><div class="kick"><span class="live">LIVE</span><span class="when">WORLDMONITOR · TODAY</span></div><div class="h1">That was last week, by hand. This is today, live.</div></div>
      <div class="body"></div>`;
  },
  async enter(root) {
    const body = root.querySelector('.body');
    if (!LIVE.board) body.innerHTML = '<div class="glass offline">Loading WorldMonitor…</div>';
    const b = await loadBoard();
    if (!b) {
      body.innerHTML = `<div class="glass offline"><b>Live desk not reachable.</b> ${esc(LIVE.boardError ?? '')}<br>Start it with <code>npm start</code> in demos/verification-desk and open this deck from http://localhost:4317.</div>`;
      return;
    }
    // A board that is not live must say when it is from, with the date: the
    // committed snapshot is from the day before the show.
    const live = b.from === 'live' && !b.fromCache;
    const when = new Date(b.fromCache && b.cacheSavedAt ? b.cacheSavedAt : b.asOf);
    root.querySelector('.when').textContent = live
      ? `WORLDMONITOR · LIVE · ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : `WORLDMONITOR · LAST SNAPSHOT · ${when.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    root.querySelector('.h1').textContent = live ? 'That was last week, by hand. This is today, live.' : 'That was last week, by hand. This is WorldMonitor\'s last snapshot.';
    root.querySelector('.live').textContent = live ? 'LIVE' : 'SNAPSHOT';
    const picks = boardPicks(b);
    LIVE.picks = picks; // story numbers on the board are live before the check scene is opened
    const t = b.totals;
    body.innerHTML = `<div class="totals"><div class="tot"><b class="n0">0</b><span>stories<br>tracked</span></div><div class="tot"><b class="n1 c-ver">0</b><span>corroborated<br>2+ publishers</span></div><div class="tot"><b class="n2 c-unv">0</b><span>single<br>publisher</span></div></div>
      <div class="cols"><div class="col"><div class="secthead c-ver"><span class="dot"></span>CORROBORATED · WORLDMONITOR</div><div class="vstack"></div></div>
      <div class="col"><div class="secthead c-unv"><span class="dot"></span>IN CIRCULATION · ONE PUBLISHER</div><div class="posts"></div></div></div>
      <div class="foot">WorldMonitor's coverage verdict and CRED score on every story. Tiers rank sources; they do not judge the claim. Click a story, or press its number, to check it live.</div>`;
    root._totals = [t.stories, t.corroborated, t.singlePublisher + t.lowTierOnly + t.unknown];
    const vs = body.querySelector('.vstack');
    b.supported.slice(0, 4).forEach((s, i) => {
      const el = h('div', 'vitem rv', `<div class="ic">✓</div><div><div class="t"><span class="num">${i + 1}</span>${esc(s.title)}</div><div class="badges"><span class="badge tier">${s.publishers} PUBLISHERS</span>${credBadge(s.credibility, s.band)}${s.top.slice(0, 2).map((x) => `<span class="badge">${x.tier ? `T${x.tier}` : 'T?'} ${esc(x.name)}</span>`).join('')}${s.stateAffiliated.map((c) => `<span class="badge state">STATE · ${esc(c.toUpperCase())}</span>`).join('')}</div></div>`);
      el.onclick = (e) => { e.stopPropagation(); checkPick(picks.indexOf(s)); };
      vs.appendChild(el);
    });
    const ps = body.querySelector('.posts');
    b.thin.slice(0, 3).forEach((s, i) => {
      const lead = s.top[0];
      const el = h('div', `post s-${STATE_CLS[s.state] ?? 'unv'}`, `<div class="hd"><div class="av">${esc((lead?.name ?? '?')[0])}</div><div><div class="nm"><span class="num">${b.supported.slice(0, 4).length + i + 1}</span>${esc(lead?.name ?? 'Unknown publisher')}</div><div class="mt">${lead?.tier ? `T${lead.tier}` : 'T?'} · CRED ${s.credibility ?? '–'}${s.stateAffiliated.length ? ` · state-affiliated: ${esc(s.stateAffiliated.join(', '))}` : ''}</div></div></div><div class="tx">${esc(s.title)}</div><div class="stamp">${s.state === 'tier4-only' ? 'LOW-TIER ONLY' : 'SINGLE PUBLISHER'}<small>COVERAGE, NOT ACCURACY</small></div>`);
      el.onclick = (e) => { e.stopPropagation(); checkPick(picks.indexOf(s)); };
      ps.appendChild(el);
    });
    root._counted = false;
    this.render(root, S.step);
  },
  render(root, step) {
    const totals = root.querySelector('.totals');
    if (!totals) return;
    totals.classList.add('in');
    if (!root._counted && root._totals) {
      root._counted = true;
      root._totals.forEach((v, i) => countUp(root.querySelector(`.n${i}`), 0, v, 1200, (x) => String(Math.round(x))));
    }
    $$('.vitem', root).forEach((e, i) => {
      const show = step >= 1;
      if (show && !e.classList.contains('in')) { e.style.transitionDelay = `${i * 0.3}s`; e.classList.add('in'); setTimeout(() => SFX.tick(1400, 0.03), i * 300); }
      if (!show) e.classList.remove('in');
    });
    $$('.post', root).forEach((p, i) => {
      const show = step >= 2;
      if (show && !p.classList.contains('in')) {
        setTimeout(() => {
          p.classList.add('in');
          setTimeout(() => { if (p.classList.contains('in')) { p.classList.add('stamped', 'shake'); SFX.thud(); } }, 700);
        }, i * 650);
      }
      if (!show) p.classList.remove('in', 'stamped', 'shake');
    });
  },
  notes: [
    'LIVE from WorldMonitor. The counters are today\'s stories, graded by WorldMonitor\'s own corroboration rule. PageDown builds the columns. V: the analyst reads the board.',
    'Corroborated: 2+ independent publishers, with WorldMonitor\'s CRED score and the best-tier sources. 1–4 checks one live.',
    'In circulation: one publisher only. Point at the stamp: "coverage, not accuracy". 5–7 checks one live. PageDown goes to the live check.',
  ],
});

/* ---------- scene: live check ---------- */

const LANES = [
  { k: 'off', name: 'OFFICIAL / PRIMARY', sub: 'governments · official bodies', types: ['gov'] },
  { k: 'wire', name: 'WIRE SERVICES', sub: 'news agencies', types: ['wire'] },
  { k: 'press', name: 'PRESS & BROADCAST', sub: 'newspapers · TV · business press', types: ['mainstream', 'market'] },
  { k: 'spec', name: 'SPECIALIST & OSINT', sub: 'defence · tech · analysts', types: ['intel', 'tech'] },
  { k: 'other', name: 'NOT YET REVIEWED', sub: 'source type not declared', types: [] },
];
const laneOf = (type) => (LANES.find((l) => l.types.includes(type)) ?? LANES[4]).k;
const nodeCls = (r) => (r.stateAffiliated ? 'n-org' : r.band === 'high' ? 'n-sup' : r.band === 'medium' ? 'n-ctx' : 'n-rel');

addScene({
  id: 'livecheck', title: 'Live check', sub: 'A headline from the room', globe: 'horizon', steps: 2, factual: true,
  voice: (step) => (step >= 1 && LIVE.checkVoice ? LIVE.checkVoice : null),
  build(root) {
    root.innerHTML = `<div class="head"><div class="kick"><span class="n">LIVE</span>WORLDMONITOR DATA · NOT A SCRIPT</div><div class="h1">Name a headline. Watch WorldMonitor check it.</div></div><div class="pick"></div>
      <div class="typebox"><input id="lcin" placeholder="Type the headline the room shouts…" maxlength="160"><div class="hint">ENTER to check<br>ESC to cancel</div></div>
      <div class="run"><div class="glass claimbar"><div class="lb">HEADLINE</div><div class="tx"></div></div><div class="parsed"></div>
      <div class="pipe">${['CAPTURE', 'FIND IN WORLDMONITOR', 'PUBLISHERS', 'SOURCE QUALITY', 'GROUNDING', 'VERDICT'].map((x, i) => `<div class="st" data-i="${i}"><i>${i + 1}</i>${x}</div>`).join('')}</div>
      <div class="lanes">${LANES.map((l) => `<div class="lane" data-k="${l.k}"><div class="ln"><b>${l.name}</b><small>${l.sub}</small></div><div class="nodes"><div class="beam"></div><span class="none">— NONE —</span></div></div>`).join('')}</div>
      <div class="rcol"><div class="tiles"><div class="glass tile"><div class="l">INDEPENDENT<br>PUBLISHERS</div><div class="v vpub c-ver">–</div></div><div class="glass tile"><div class="l">TIER-1<br>PUBLISHERS</div><div class="v vt1 c-evo">–</div></div></div>
      <div class="glass issues"><div class="l">WHAT WORLDMONITOR FLAGS</div><ul></ul></div>
      <div class="glass dialw"><div class="l">WORLDMONITOR CREDIBILITY</div>${dialSVG()}<div class="cl">—</div></div></div>
      <div class="glass verdict"><div class="vs"></div><div class="rat"></div><div class="lbl">LIVE · WORLDMONITOR<br>COVERAGE, NOT ACCURACY</div></div></div>`;
    const inp = root.querySelector('#lcin');
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && inp.value.trim()) runCheck(inp.value.trim()); if (e.key === 'Escape') closeType(); });
    inp.addEventListener('click', (e) => e.stopPropagation());
  },
  async enter(root) {
    resetCheck();
    const b = await loadBoard();
    const pk = root.querySelector('.pick');
    LIVE.picks = b ? boardPicks(b) : [];
    const shown = b ? [...b.supported.slice(0, 3), ...b.thin.slice(0, 2)] : [];
    pk.innerHTML = '';
    shown.forEach((s) => {
      const i = LIVE.picks.indexOf(s);
      const e = h('div', 'glass pc', `<div class="n">STORY ${i + 1} · ${s.state === 'corroborated' ? 'CORROBORATED' : 'ONE PUBLISHER'}</div><div class="t">${esc(s.title)}</div><div class="meta">${credBadge(s.credibility, s.band)}<span class="badge">${s.publishers} PUBLISHER${s.publishers === 1 ? '' : 'S'}</span></div>`);
      e.dataset.i = String(i);
      e.onclick = (ev) => { ev.stopPropagation(); checkPick(i); };
      pk.appendChild(e);
    });
    const cu = h('div', 'glass pc custom', '<div class="n">T · TYPE WHAT THE ROOM SHOUTS</div><div class="t">Any headline from this week: WorldMonitor checks it live.</div>');
    cu.onclick = (ev) => { ev.stopPropagation(); openType(); };
    pk.appendChild(cu);
    if (!b) pk.insertAdjacentHTML('beforebegin', `<div class="glass offline"><b>Live desk not reachable.</b> Typed headlines still work if the server comes back.</div>`);
    highlightPick();
  },
  render(root, step) {
    if (step === 0) { resetCheck(); highlightPick(); return; }
    if (!root.classList.contains('running')) {
      const s = LIVE.picks[LIVE.pickSel];
      if (s) runCheck(s.title);
      else openType();
    }
  },
  notes: [
    'LIVE. Click a story, press its number, or T and type what the room shouts. PageDown checks the highlighted story.',
    'Every node is a real publisher, placed by WorldMonitor\'s source type: tier, CRED, state affiliation. The dial is WorldMonitor\'s credibility score. V: the analyst reads the verdict. Backspace: pick another.',
  ],
});

function highlightPick() { $$('#s-livecheck .pc').forEach((e) => e.classList.toggle('sel', e.dataset.i === String(LIVE.pickSel))); }
function openType() { const t = $('#s-livecheck .typebox'); t.classList.add('on'); const i = $('#lcin'); i.value = ''; setTimeout(() => i.focus(), 50); }
function closeType() { const t = $('#s-livecheck .typebox'); if (!t) return; t.classList.remove('on'); $('#lcin')?.blur(); }
function resetCheck() {
  clearTimers();
  LIVE.run = (LIVE.run ?? 0) + 1;
  LIVE.running = false;
  const r = $('#s-livecheck');
  if (r) r.classList.remove('running');
  closeType();
}

function checkPick(i) {
  const s = LIVE.picks[i];
  if (!s) return;
  LIVE.pickSel = i;
  if (cur().id !== 'livecheck') go('livecheck', 0);
  runCheck(s.title);
}

async function runCheck(headline) {
  headline = String(headline ?? '').trim();
  if (!headline) return;
  LIVE.lastHeadline = headline;
  closeType();
  const root = $('#s-livecheck');
  Voice.stop(true);
  clearTimers();
  const run = LIVE.run = (LIVE.run ?? 0) + 1;
  LIVE.running = true;
  LIVE.checkVoice = null;
  root.classList.add('running');
  if (cur().id === 'livecheck' && S.step < 1) { S.step = 1; updateHud(); }
  const tx = root.querySelector('.claimbar .tx');
  const parsed = root.querySelector('.parsed');
  const pipe = $$('.pipe .st', root);
  const vd = root.querySelector('.verdict');
  const lanes = root.querySelector('.lanes');
  tx.innerHTML = ''; parsed.innerHTML = ''; pipe.forEach((p) => { p.className = 'st'; }); vd.className = 'glass verdict';
  $$('.lane', root).forEach((l) => { l.classList.remove('scan', 'scanned'); $$('.node', l).forEach((n) => n.remove()); });
  root.querySelector('.vpub').textContent = '–'; root.querySelector('.vt1').textContent = '–'; root.querySelector('.issues ul').innerHTML = '';
  root.querySelector('.darc').style.strokeDashoffset = 440; root.querySelector('.needle').style.transform = 'rotate(-90deg)';
  const cl = root.querySelector('.dialw .cl'); cl.textContent = '—'; cl.style.color = '';
  const setSt = (i) => pipe.forEach((p, j) => { p.classList.toggle('done', j < i); p.classList.toggle('act', j === i); });

  // Type the headline while WorldMonitor is queried.
  setSt(0);
  let k = 0;
  const typer = () => { k += 2; tx.innerHTML = `${esc(headline.slice(0, k))}<span class="cur"></span>`; if (k < headline.length) at(24, typer); else tx.textContent = headline; };
  typer();
  const t0 = performance.now();
  at(900, () => { setSt(1); lanes.classList.add('searching'); });
  const r = await grade(headline);
  if (run !== LIVE.run || !LIVE.running || root !== $('#s-livecheck')) return;
  const wait = Math.max(0, 1600 - (performance.now() - t0));
  LIVE.result = r;
  at(wait, () => play(root, r, { setSt, parsed, lanes, vd, cl, run }));
}

function play(root, r, { setSt, parsed, lanes, vd, cl, run }) {
  lanes.classList.remove('searching');
  if (r.failure) {
    setSt(5);
    vd.className = 'glass verdict s-gap';
    vd.querySelector('.vs').textContent = 'SOURCES UNREACHABLE';
    vd.querySelector('.rat').innerHTML = `<div>${esc(r.failure)}</div><div>No check, so no verdict.</div>`;
    vd.classList.add('in');
    LIVE.running = false;
    return;
  }
  const found = Boolean(r.match);
  const who = r.who;
  const rated = who?.rated ?? [];
  const chips = found
    ? { 'found': r.match.title.length > 70 ? `${r.match.title.slice(0, 70)}…` : r.match.title, 'lead': r.when?.primarySource ?? rated[0]?.name ?? '?', 'first seen': r.when?.firstSeen ? new Date(r.when.firstSeen).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '?', 'clusters': String(r.when?.mergedClusters ?? 1) }
    : { 'found': 'nothing in WorldMonitor\'s window', 'searched': (r.terms ?? []).join(' · ') };
  Object.entries(chips).forEach(([key, v], i) => {
    const s = h('span', '', `<b>${key.toUpperCase()}</b>${esc(v)}`);
    parsed.appendChild(s);
    at(i * 180, () => { s.classList.add('in'); SFX.tick(1800, 0.02); });
  });

  let t = 700;
  at(t, () => setSt(2));
  LANES.forEach((l, li) => {
    const lane = root.querySelector(`.lane[data-k="${l.k}"]`);
    const nodes = lane.querySelector('.nodes');
    const list = rated.filter((x) => laneOf(x.type) === l.k);
    at(t + li * 420, () => { lane.classList.add('scan'); SFX.tick(700 + li * 120, 0.03); });
    list.slice(0, 3).forEach((x, ni) => {
      const extra = x.stateAffiliated ? `state-affiliated · ${x.stateAffiliated}` : x.riskReviewed ? `${x.risk} propaganda risk` : 'propaganda risk not reviewed';
      const e = h('div', `node ${nodeCls(x)}`, `<div class="nn"><em>${x.tier ? `T${x.tier}` : 'T?'} · CRED ${x.credibility}</em>${esc(x.name)}</div><div class="nx">${esc(extra)}</div>`);
      e.title = x.summary ?? '';
      nodes.appendChild(e);
      at(t + li * 420 + 260 + ni * 220, () => { e.classList.add('in'); SFX.tick(x.band === 'high' ? 1600 : 1100, 0.04); });
    });
    if (list.length > 3) {
      const more = h('div', 'node n-sil', `<div class="nn">+${list.length - 3} more</div>`);
      nodes.appendChild(more);
      at(t + li * 420 + 260 + 3 * 220, () => more.classList.add('in'));
    }
    if (!list.length) at(t + li * 420 + 400, () => lane.classList.add('scanned'));
  });
  t += LANES.length * 420 + 600;

  at(t, () => {
    setSt(3);
    const pub = root.querySelector('.vpub');
    const t1 = root.querySelector('.vt1');
    const n = who?.coverage?.publishers ?? 0;
    const tier1 = rated.filter((x) => x.tier === 1).length;
    countUp(pub, 0, n, 600, (v) => String(Math.round(v)));
    countUp(t1, 0, tier1, 600, (v) => String(Math.round(v)));
  });
  t += 900;
  at(t, () => {
    setSt(4);
    const ul = root.querySelector('.issues ul');
    // The card's flags, without the two lines the tiles and dial already show.
    const flags = (r.verdict?.reasons ?? []).filter((x) => !/^Reported by|^WorldMonitor credibility/.test(x));
    (flags.length ? flags : ['Nothing flagged.']).slice(0, 4).forEach((x, i) => { const li = h('li', '', esc(x)); ul.appendChild(li); at(120 + i * 300, () => li.classList.add('in')); });
  });
  t += 1100;
  at(t, () => {
    const c = who?.credibility;
    if (!c) { cl.textContent = 'NOT SCORED'; cl.style.color = 'var(--gap)'; root.querySelector('.needle').style.transform = 'rotate(0deg)'; return; }
    const f = Math.max(0, Math.min(1, c.score / 100));
    root.querySelector('.darc').style.strokeDashoffset = 440 * (1 - f);
    root.querySelector('.needle').style.transform = `rotate(${-90 + 180 * f}deg)`;
    cl.textContent = `CRED ${c.score} · ${c.band.toUpperCase()}`;
    cl.style.color = BAND_COL[c.band] ?? '';
  });
  t += 1300;
  at(t, async () => {
    setSt(5);
    const v = r.verdict ?? {};
    vd.className = `glass verdict s-${STATE_CLS[v.key] ?? 'gap'}`;
    vd.querySelector('.vs').textContent = (v.word ?? 'Unverifiable').toUpperCase();
    vd.querySelector('.rat').innerHTML = [v.hint ?? v.reasons?.[0], who?.summary ? `${who.summary}${who.credibility ? ` · CRED ${who.credibility.score} (${who.credibility.from ?? who.credibility.source})` : ''}.` : null]
      .filter(Boolean).map((x) => `<div>${esc(x)}</div>`).join('');
    vd.getBoundingClientRect();
    vd.classList.add('in');
    SFX.thud();
    at(600, () => { pipeDone(root); LIVE.running = false; });
    // The anchor's line may still be on its way; a replaced check must not
    // speak over the one that replaced it.
    const text = typeof r.script === 'string' ? r.script : await r.script;
    if (run !== LIVE.run || !text) return;
    LIVE.checkVoice = await prepareNarration('live_check', text);
    if (run !== LIVE.run) return;
    updateHud();
    if (S.autoNarrate) Voice.play(LIVE.checkVoice);
  });
}
function pipeDone(root) { $$('.pipe .st', root).forEach((p) => { p.classList.remove('act'); p.classList.add('done'); }); }

/* ---------- show order, keys, help ---------- */

// The live scenes take the illustrative engine's place; the engine stays in the menu.
ORDER_ALL.splice(ORDER_ALL.indexOf('engine'), 0, 'liveboard', 'livecheck');
const ei = CONFIG.storyOrder.indexOf('engine');
if (ei >= 0) CONFIG.storyOrder.splice(ei, 1, 'liveboard', 'livecheck');
else CONFIG.storyOrder.splice(CONFIG.storyOrder.length - 1, 0, 'liveboard', 'livecheck');
S.order = CONFIG.storyOrder.filter((id) => SC[id]);

HELP.push(['#', 'LIVE WORLDMONITOR'], ['1–7', 'live board: check that story'], ['T', 'live check: type a headline'], ['⌫', 'live check: back to the picks'], ['⇧U', 'live board: refresh now'], ['G', 'live avatar ↔ animated avatar']);

const deckKey = window.onKey;
window.onKey = function onKeyLive(e) {
  if (e.target && e.target.tagName === 'INPUT') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return deckKey(e);
  const k = e.key;
  const code = e.code || '';
  const d = cur();
  if (k === 'g' || k === 'G') { $('#start')?.classList.add('gone'); toggleHeygen(); return; }
  if (d.id === 'liveboard' && /^Digit[1-9]$/.test(code)) { checkPick(+code[5] - 1); return; }
  // Shift+U: plain U is the deck's mute key, and a reflex mute must not spend WorldMonitor calls.
  if (d.id === 'liveboard' && k === 'U' && e.shiftKey) {
    toast('Refreshing from WorldMonitor…');
    loadBoard(true).then(async () => {
      if (cur().id !== 'liveboard') return;
      S.step = 0; updateHud();
      await SC.liveboard.enter($('#s-liveboard'));
      toast(LIVE.boardError ? `Refresh failed: ${LIVE.boardError}` : 'Board refreshed from WorldMonitor');
    });
    return;
  }
  if (d.id === 'livecheck' && /^Digit[1-9]$/.test(code)) { checkPick(+code[5] - 1); return; }
  if (d.id === 'livecheck' && (k === 't' || k === 'T')) { e.preventDefault?.(); resetCheck(); S.step = 0; updateHud(); openType(); return; }
  if (d.id === 'livecheck' && k === 'Backspace') { e.preventDefault?.(); resetCheck(); S.step = 0; updateHud(); highlightPick(); return; }
  // Enter re-runs the last headline, including after a failed check (whose result has no headline).
  if (d.id === 'livecheck' && k === 'Enter' && LIVE.lastHeadline) { runCheck(LIVE.lastHeadline); return; }
  return deckKey(e);
};

/* ---------- control bar: the live keys as buttons ---------- */

// Each button fires the same key the keyboard would, so there is one code
// path. Scene-bound buttons appear only on their scene; toggles show state.
const LIVE_BUTTONS = [
  { key: 'g', label: '👤 G AVATAR', title: 'G: live avatar on / off (metered while on)', always: true, on: () => heygen.isWanted() },
  { key: 'l', label: '▶ L AUTO', title: 'L: speak each beat on arrival', always: true, on: () => S.autoNarrate },
  { key: 'U', shift: true, label: '⟳ ⇧U REFRESH', title: 'Shift+U: refresh the board from WorldMonitor (2 calls)', scene: 'liveboard' },
  { key: 't', label: '⌨ T TYPE', title: 'T: type a headline from the room', scene: 'livecheck' },
  { key: 'Enter', label: '↵ RE-RUN', title: 'Enter: run the last headline again', scene: 'livecheck', enabled: () => Boolean(LIVE.lastHeadline) },
  { key: 'Backspace', label: '⌫ PICKS', title: 'Backspace: back to the story picks', scene: 'livecheck' },
];

function installLiveButtons() {
  const ctrl = $('#ctrl');
  if (!ctrl || ctrl.querySelector('.live-sep')) return;
  ctrl.insertAdjacentHTML('beforeend', '<span class="live-sep"></span>');
  for (const b of LIVE_BUTTONS) {
    const el = h('button', 'live-btn', esc(b.label));
    el.title = b.title;
    el.onclick = (e) => {
      e.stopPropagation();
      const code = b.key.length === 1 ? `Key${b.key.toUpperCase()}` : b.key;
      window.onKey({ key: b.key, code, target: null, preventDefault() {}, shiftKey: Boolean(b.shift) });
      refreshLiveButtons();
    };
    ctrl.appendChild(el);
    b.el = el;
  }
  refreshLiveButtons();
}

function refreshLiveButtons() {
  const id = cur()?.id;
  for (const b of LIVE_BUTTONS) {
    if (!b.el) continue;
    const show = Boolean(b.always) || b.scene === id;
    b.el.hidden = !show;
    b.el.disabled = show && b.enabled ? !b.enabled() : false;
    b.el.classList.toggle('on', Boolean(b.on?.()));
  }
}

// The deck redraws its HUD on every scene and step change; the buttons follow.
const deckUpdateHud = window.updateHud;
window.updateHud = function updateHudLive(...args) {
  const out = deckUpdateHud(...args);
  refreshLiveButtons();
  return out;
};
heygen.onStatus(({ ready, wanted }) => { $('#avatar')?.classList.toggle('heygen', ready && wanted); refreshLiveButtons(); });

/* ---------- boot ---------- */

addEventListener('load', async () => {
  const av = $('#avatar');
  if (av && !av.querySelector('video')) av.insertAdjacentHTML('afterbegin', '<video autoplay playsinline></video>');
  installLiveButtons();
  try { LIVE.config = await fetch('/api/config').then((r) => r.json()); } catch { LIVE.config = {}; }
  loadBoard(); // warm, so the live board is instant when the show reaches it
});
