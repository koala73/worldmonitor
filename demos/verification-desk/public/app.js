// Stage client. Every piece of data from the server goes in with textContent,
// never innerHTML: headlines are untrusted text.

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let config = { stepDelayMs: 1400, tts: 'browser' };
let runId = 0;
let currentSource = null;

/* ---------- views ---------- */

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${view}`);
}

function setAnchorState(text, speaking = false) {
  $('#anchor-state').textContent = text;
  $('#anchor').classList.toggle('speaking', speaking);
}

/* ---------- voice + captions ---------- */

const bars = [];
for (let i = 0; i < 9; i += 1) { const b = el('i'); $('#bars').append(b); bars.push(b); }
let level = () => 0;
(function animateBars() {
  const speaking = $('#anchor').classList.contains('speaking');
  const base = level();
  bars.forEach((b, i) => {
    const wobble = speaking ? (base || 0.35) * (0.45 + 0.55 * Math.abs(Math.sin(Date.now() / 120 + i * 1.7))) : 0.04;
    b.style.height = `${Math.max(6, Math.min(100, wobble * 100))}%`;
  });
  requestAnimationFrame(animateBars);
})();

// Subtitles: the sentence being spoken, with the previous one dimmed above it.
function renderCaption(text, spokenChars) {
  const sentences = text.match(/[^.!?]+[.!?]+["”']?\s*|[^.!?]+$/g) ?? [text];
  let start = 0;
  let i = 0;
  for (; i < sentences.length - 1; i += 1) {
    if (start + sentences[i].length > spokenChars) break;
    start += sentences[i].length;
  }
  const current = sentences[i];
  const inCurrent = Math.max(0, spokenChars - start);
  const nodes = [];
  if (i > 0) nodes.push(el('span', 'prev', sentences[i - 1].trim()));
  nodes.push(el('span', 'spoken', current.slice(0, inCurrent)), el('span', 'pending', current.slice(inCurrent)));
  $('#caption').replaceChildren(...nodes);
}

let audioEl = null;
let audioCtx = null;

function stopVoice() {
  if (audioEl) { audioEl.pause(); audioEl = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  level = () => 0;
  setAnchorState('standing by', false);
}

async function speakElevenLabs(text, onProgress, myRun) {
  const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (res.status !== 200) throw new Error('tts unavailable');
  const blob = await res.blob();
  if (myRun !== runId) return;
  audioEl = new Audio(URL.createObjectURL(blob));
  audioCtx ??= new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  audioCtx.createMediaElementSource(audioEl).connect(analyser);
  analyser.connect(audioCtx.destination);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  level = () => { analyser.getByteFrequencyData(buf); return buf.reduce((a, b) => a + b, 0) / buf.length / 110; };
  const a = audioEl;
  await new Promise((resolve) => {
    a.ontimeupdate = () => a.duration && onProgress(a.currentTime / a.duration);
    a.onended = resolve;
    a.onerror = resolve;
    a.play().catch(resolve);
  });
}

function speakBrowser(text, onProgress) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { onProgress(1); resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => /en-(GB|US)/.test(v.lang) && /Natural|Google|Daniel|Samantha|Aria|Guy/i.test(v.name)) ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
    u.rate = 1.02;
    u.onboundary = (e) => onProgress(e.charIndex / text.length);
    u.onend = () => { onProgress(1); resolve(); };
    u.onerror = () => { onProgress(1); resolve(); };
    speechSynthesis.speak(u);
  });
}

async function speak(text, { onProgress = () => {} } = {}) {
  const myRun = runId;
  if (!text) return;
  const progress = (p) => { if (myRun === runId) { renderCaption(text, Math.round(text.length * Math.min(1, p))); onProgress(p); } };
  renderCaption(text, 0);
  setAnchorState('on air', true);
  try {
    if (config.tts === 'elevenlabs') await speakElevenLabs(text, progress, myRun);
    else await speakBrowser(text, progress);
  } catch {
    await speakBrowser(text, progress);
  }
  if (myRun === runId) { progress(1); setAnchorState('standing by', false); level = () => 0; }
}

/* ---------- reset ---------- */

function resetAll() {
  runId += 1;
  if (currentSource) { currentSource.close(); currentSource = null; }
  stopVoice();
  $('#caption').replaceChildren();
  show('idle');
}

/* ---------- recap ---------- */

async function runRecap() {
  resetAll();
  const myRun = runId;
  setAnchorState('preparing the week…');
  const data = await fetch('/api/recap').then((r) => r.json());
  if (myRun !== runId) return;
  if (data.error) { $('#caption').textContent = data.error; return; }
  $('#recap-scope').textContent = `Recap · ${data.scope}${data.fromCache ? ' · last good copy' : ''}`;
  const list = $('#recap-list');
  list.replaceChildren();
  const marks = [];
  for (const s of data.stories) {
    const li = el('li');
    li.append(el('span', '', s.title));
    const n = s.publishers;
    const chips = el('span', 'chips');
    chips.append(el('span', `chip ${s.state || 'unknown'}`, n == null ? 'count unknown' : n <= 1 ? '1 publisher' : `${n} publishers`));
    if (s.credibility != null) chips.append(el('span', `chip cred band-${s.band}`, `CRED ${s.credibility}`));
    li.append(chips);
    list.append(li);
    const key = s.title.split(/\s+/).slice(0, 3).join(' ').toLowerCase();
    const at = data.script.toLowerCase().indexOf(key);
    marks.push({ li, at: at >= 0 ? at / data.script.length : null });
  }
  marks.forEach((m, i) => { if (m.at === null) m.at = (i + 1) / (marks.length + 2); });
  show('recap');
  await speak(data.script, { onProgress: (p) => marks.forEach((m) => m.li.classList.toggle('lit', p >= m.at - 0.01)) });
}

/* ---------- grade ---------- */

function row(step) { return document.querySelector(`.checks li[data-step="${step}"]`); }

function fmtTime(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const renderers = {
  who(d) {
    const out = el('div');
    if (!d) { out.append(el('span', 'warn', 'No publisher WorldMonitor monitors carried it.')); return out; }
    const head = el('div', 'who-head');
    head.append(el('span', 'big', d.coverage.publishers ?? '?'), el('span', '', d.summary ?? ''));
    if (d.credibility) head.append(el('span', `cred band-${d.credibility.band}`, `CRED ${d.credibility.score}`));
    out.append(head);
    const flag = { 'single-publisher': 'Single publisher', 'tier4-only': 'Low-tier sources only' }[d.coverage.state];
    if (flag) out.append(el('div', 'warn', flag));
    // WorldMonitor's roster order: best declared tier first.
    const list = el('ol', 'ranked');
    for (const r of (d.rated ?? []).slice(0, 5)) {
      const li = el('li');
      li.title = r.summary ?? '';
      li.append(el('span', `tier t${r.tier ?? 0}`, r.tier ? `T${r.tier}` : 'T?'), el('span', 'name', r.name), el('span', `cred band-${r.band}`, `CRED ${r.credibility}`));
      const tags = el('span', 'tags');
      if (r.stateAffiliated) tags.append(el('span', 'tag bad', `state: ${r.stateAffiliated}`));
      tags.append(el('span', `tag risk-${r.risk}`, r.riskReviewed ? `${r.risk} risk` : 'risk not reviewed'));
      li.append(tags);
      list.append(li);
    }
    out.append(list);
    const more = Math.max(0, (d.rated?.length ?? 0) - 5) + (d.unlisted ?? 0);
    if (more) out.append(el('div', 'mono', `+${more} more`));
    if (d.seeder?.entityCorroboration === false) out.append(el('div', 'warn', 'Entity-corroboration gate did not fire'));
    out.append(el('div', 'legend', 'Tiers rank sources; they do not judge this claim.'));
    return out;
  },
  when(d) {
    const out = el('div');
    if (!d) { out.append(el('span', 'warn', 'No timeline: nothing to trace.')); return out; }
    out.append(el('div', 'mono', `First seen ${fmtTime(d.firstSeen)} · spread over ${d.spreadHours ?? '?'}h`));
    if (d.mergedClusters > 1) out.append(el('div', '', `Found across ${d.mergedClusters} WorldMonitor clusters`));
    if (d.primarySource) out.append(el('div', '', `Lead source: ${d.primarySource}`));
    return out;
  },
  numbers(d) {
    const out = el('div');
    if (!d.facts?.length) { out.append(el('span', '', d.gate === 'not-checked' ? 'Nothing to check.' : 'No figures in the headline to check.')); return out; }
    for (const f of d.facts) {
      if (!f.grounded) out.append(el('div', 'bad', `✗ ${f.label} is not grounded in any source text`));
      else if (f.statedBy?.length === 1) out.append(el('div', 'warn', `✓ ${f.label} is grounded, but only one publisher states it: ${f.statedBy[0]}`));
      else out.append(el('div', 'good', `✓ ${f.label} is grounded in the sources${f.statedBy?.length > 1 ? ` (${f.statedBy.length} publishers)` : ''}`));
    }
    out.append(el('div', 'mono', `WorldMonitor's fact-grounding gate · ${d.evidence}`));
    return out;
  },
  money(d) {
    const out = el('div');
    if (!d.markets.length) { out.append(el('span', '', 'No prediction market on this event.')); return out; }
    for (const m of d.markets.slice(0, 2)) {
      const line = el('div');
      line.append(el('span', 'big', `${Math.round(m.yesPrice)}%`), el('span', '', m.title), el('span', 'mono', `  · ${m.source ?? 'market'}`));
      out.append(line);
    }
    return out;
  },
};

function runGrade(headline) {
  resetAll();
  const myRun = runId;
  $('#grade-headline').textContent = headline;
  for (const li of document.querySelectorAll('.checks li')) { li.className = ''; li.querySelector('.out').replaceChildren(); }
  $('#verdict').hidden = true;
  $('#verdict-pending').hidden = false;
  show('grade');
  setAnchorState('checking…');
  $('#caption').textContent = 'Running it through the desk.';

  const queue = [];
  let wake = null;
  const push = (ev) => { queue.push(ev); if (wake) { wake(); wake = null; } };
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => { wake = r; }).then(() => queue.shift()));

  const es = new EventSource(`/api/grade?headline=${encodeURIComponent(headline)}`);
  currentSource = es;
  for (const step of ['match', 'who', 'when', 'numbers', 'money', 'verdict', 'script', 'done', 'failure']) {
    es.addEventListener(step, (e) => push({ step, data: JSON.parse(e.data) }));
  }
  es.onerror = () => { es.close(); push({ step: 'closed' }); };

  (async () => {
    const order = ['who', 'when', 'numbers', 'money'];
    let pending = 0;
    row(order[0]).classList.add('running');
    for (;;) {
      const ev = await next();
      if (myRun !== runId) return;
      if (ev.step === 'failure') { $('#caption').textContent = `The desk hit an error: ${ev.data.message}`; setAnchorState('error'); return; }
      if (ev.step === 'closed' || ev.step === 'done') { es.close(); if (ev.step === 'closed') return; continue; }
      if (ev.step === 'match') {
        $('#caption').textContent = ev.data.match
          ? `Found it: “${ev.data.match.title}”`
          : ev.data.closest ? `Nothing matches. Closest: “${ev.data.closest.title}”` : 'No monitored outlet carries anything like it.';
        continue;
      }
      if (order.includes(ev.step)) {
        const li = row(ev.step);
        li.classList.remove('running');
        li.classList.add('done');
        li.querySelector('.out').replaceChildren(renderers[ev.step](ev.data));
        pending = order.indexOf(ev.step) + 1;
        if (order[pending]) {
          row(order[pending]).classList.add('running');
          row(order[pending]).scrollIntoView({ block: 'nearest' });
        }
        await sleep(config.stepDelayMs);
        continue;
      }
      if (ev.step === 'verdict') {
        const v = $('#verdict');
        // Colour: WorldMonitor's coverage state; a corroborated story takes its credibility band.
        v.className = `verdict v-${ev.data.key}${ev.data.key === 'corroborated' && ev.data.band ? ` cred-${ev.data.band}` : ''}`;
        $('#verdict-word').textContent = ev.data.word;
        const ul = $('#verdict-reasons');
        ul.replaceChildren(...ev.data.reasons.map((r) => el('li', '', r)));
        $('#verdict-hint').textContent = ev.data.hint ?? '';
        v.hidden = false;
        $('#verdict-pending').hidden = true;
        continue;
      }
      if (ev.step === 'script') { speak(ev.data.text); }
    }
  })();
}

/* ---------- reveal ---------- */

function drawLines() {
  const svg = $('#cascade-lines');
  const box = $('.cascade').getBoundingClientRect();
  const origin = $('#cascade-origin').getBoundingClientRect();
  const ox = origin.left - box.left;
  const oy = origin.top - box.top + origin.height / 2;
  svg.replaceChildren();
  [...document.querySelectorAll('.tile')].forEach((t, i) => {
    const r = t.getBoundingClientRect();
    const x = r.right - box.left;
    const y = r.top - box.top + r.height / 2;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', `M${x},${y} C${(x + ox) / 2},${y} ${(x + ox) / 2},${oy} ${ox},${oy}`);
    p.style.animationDelay = `${i * 90}ms`;
    svg.append(p);
  });
}

async function runReveal() {
  resetAll();
  const myRun = runId;
  setAnchorState('pulling the story…');
  const data = await fetch('/api/reveal').then((r) => r.json());
  if (myRun !== runId) return;
  if (data.error) { $('#caption').textContent = data.error; return; }
  const c = data.candidate;
  $('#reveal-title').textContent = c.title;
  $('#cascade-tiles').replaceChildren();
  $('#cascade-lines').replaceChildren();
  $('#cascade-origin').hidden = true;
  $('#reveal-counter').textContent = '';
  show('reveal');

  const speaking = speak(data.script);
  const items = (c.memberTitles?.length ? c.memberTitles : c.feedLabels ?? []).slice(0, 9);
  const labels = c.feedLabels ?? [];
  for (let i = 0; i < items.length; i += 1) {
    if (myRun !== runId) return;
    const tile = el('div', 'tile', items[i]);
    if (labels[i] && c.memberTitles?.length) tile.append(el('small', '', labels[i]));
    tile.style.animationDelay = '0ms';
    $('#cascade-tiles').append(tile);
    $('#reveal-counter').textContent = `${i + 1} headline${i ? 's' : ''}`;
    await sleep(650);
  }
  const total = c.headlineCount ?? items.length;
  const unit = c.pattern === 'syndication' ? 'sites' : 'outlets';
  $('#reveal-counter').textContent = `${total} headlines${c.outlets ? ` · ${c.outlets} ${unit}` : ''} → traced back`;
  await sleep(900);
  if (myRun !== runId) return;
  $('#origin-count').textContent = '1';
  $('#origin-name').textContent = c.origin ?? 'one publisher family';
  $('#cascade-origin').hidden = false;
  await sleep(120);
  drawLines();
  await speaking;
}

/* ---------- microphone ---------- */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen() {
  if (!Recognition) { $('#headline').focus(); return; }
  if (rec) { rec.stop(); return; }
  rec = new Recognition();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.onresult = (e) => { $('#headline').value = [...e.results].map((r) => r[0].transcript).join(' '); };
  rec.onend = () => {
    $('#mic').classList.remove('listening');
    rec = null;
    const v = $('#headline').value.trim();
    if (v) runGrade(v);
  };
  $('#mic').classList.add('listening');
  rec.start();
}

/* ---------- wiring ---------- */

$('#ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#headline').value.trim();
  if (v) { $('#headline').blur(); runGrade(v); }
});
$('#btn-recap').onclick = () => runRecap();
$('#btn-reveal').onclick = () => runReveal();
$('#btn-stop').onclick = () => resetAll();
$('#mic').onclick = () => listen();

document.addEventListener('keydown', (e) => {
  if (e.target === $('#headline')) { if (e.key === 'Escape') $('#headline').blur(); return; }
  const k = e.key.toLowerCase();
  if (k === 'r') runRecap();
  else if (k === 's') runReveal();
  else if (k === 'm') listen();
  else if (k === '/') { e.preventDefault(); $('#headline').focus(); }
  else if (k === 'escape') resetAll();
  else if (k === 'h') $('#console').classList.toggle('hidden');
  else if (k === 'f') (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
});

setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);
window.addEventListener('resize', () => { if (!$('#cascade-origin').hidden) drawLines(); });
if ('speechSynthesis' in window) speechSynthesis.getVoices();

(async () => {
  config = { ...config, ...(await fetch('/api/config').then((r) => r.json())) };
  $('#mode-badge').textContent = config.sourceKind.includes('live') ? `LIVE · ${config.sourceKind.toUpperCase()}` : 'OFFLINE · REAL SNAPSHOT DATA';
  if (config.backdropUrl) {
    const f = el('iframe');
    f.src = config.backdropUrl;
    f.title = 'WorldMonitor live map';
    f.setAttribute('tabindex', '-1');
    $('#backdrop').append(f);
  }
  if (config.avatarEmbedUrl) {
    const f = $('#avatar-frame');
    f.src = config.avatarEmbedUrl;
    f.hidden = false;
    document.querySelector('.face').hidden = true;
    document.querySelector('.rings').hidden = true;
  }
})();
