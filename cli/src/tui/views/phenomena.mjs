// Phenomena view: a scientific-discovery monitor. The left rail lists findings
// the local Claude researched (and streams the research as it happens); the
// right stage plays a cinematic explainer for the selected finding, or, when
// nothing is selected, shows the live instrument feed: the global signal noise
// oscilloscope, a sources × time heatmap and cross-source coincidences.
import { mix, strWidth, truncate, wrap } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { rect, splitH, splitV } from '../ui/layout.mjs';
import { pulse } from '../ui/fx.mjs';
import { button, gauge, heading, hit, label, panel, segments } from '../ui/widgets.mjs';
import { isHttpUrl } from '../ui/detail.mjs';
import { ageOf } from '../data/select.mjs';
import { DotCanvas } from '../map/canvas.mjs';
import { decodeWorld, worldMask } from '../map/world.mjs';
import { PaneView, selectedItem } from './base.mjs';
import { FeedHub } from '../science/feeds.mjs';
import { GROUPS, SOURCES, groupOf } from '../science/sources.mjs';
import { composite, fmtGap, heatmap, noiseLevel, overlaps } from '../science/correlate.mjs';
import { ClaudeRunner, describeTool } from '../science/claude.mjs';
import { ASK_SYSTEM, RESEARCH_SYSTEM, STORYBOARD_SYSTEM, askPrompt, compactHarvest, repairPrompt, researchPrompt, storyboardPrompt } from '../science/prompts.mjs';
import { extractFindings, extractJson, normalizeFinding, normalizeScene, normalizeStoryboard, validateStoryboard } from '../science/storyboard.mjs';
import { Library, dataDir } from '../science/library.mjs';
import { DEMO_FINDING, DEMO_STORYBOARD } from '../science/demo.mjs';
import { Player } from '../scene/player.mjs';
import { Voice } from '../science/voice.mjs';
import { renderScene } from '../scene/render.mjs';

const NARRATION_MS_PER_CHAR = 26;
const VOICE_MS_PER_CHAR = 62; // about 175 words per minute, the speech engines' default pace
const SPEEDS = [0.25, 0.4, 0.55, 0.7, 0.85, 1, 1.25, 1.5, 2, 3];
const GLITCH = '░▒▓█▞▚▟▙◆◇⟐⟡∿≈≋';
const SECRECY_GLYPH = { public: '', buried: '▣', declassified: '▣', contested: '⚠', suppressed: '▣' };
const HEAT = ' ·░▒▓█';

export class PhenomenaView extends PaneView {
  constructor(app, { hub = null, runner = null, library = null, now = null } = {}) {
    super(app, { id: 'phenomena', label: 'Phenomena', paneIds: ['rail', 'stage'], sources: [] });
    this.now = now || (() => app.now());
    this.hub = hub || new FeedHub({ sources: SOURCES, fetch: app.fetchImpl || undefined, userAgent: app.userAgent, now: this.now, onChange: () => this.app.markDirty() });
    this.runner = runner || new ClaudeRunner({ env: app.env, model: app.prefs?.phenomenaModel || null });
    this.lib = library || new Library({ dir: dataDir(app.env || {}) });
    this.voice = new Voice({ env: app.env || {} });
    const pp = (app.prefs && app.prefs.phenomena) || {};
    this.voiceOn = pp.voice !== false;
    this.speedPref = Number.isFinite(pp.speed) && pp.speed > 0 ? pp.speed : 1;
    this.findings = [];
    this.selectedId = null;
    this.player = null;
    this.research = null; // { status, log, topic, startedAt, count, error, cost, abort }
    this.builds = new Map(); // finding id -> { status, startedAt, scenes, error, log }
    this.queue = [];
    this.building = null;
    this.prompter = null; // { kind: 'topic' | 'ask', text }
    this.mode = 'signals';
    this.canvas = null;
    this.narrationStartedAt = 0;
    this.narrationKey = '';
    this.loadLibrary();
  }

  // --- data ------------------------------------------------------------------------

  loadLibrary() {
    let list = [];
    try {
      list = this.lib.loadFindings();
    } catch {
      list = [];
    }
    if (!list.some((f) => f.id === DEMO_FINDING.id)) list.push({ ...DEMO_FINDING });
    for (const f of list) f.status = f.demo ? 'ready' : this.lib.hasExplainer(f.id) ? 'ready' : f.status === 'ready' ? 'new' : f.status || 'new';
    this.findings = list;
  }

  mount() {
    this.hub.want(true);
  }

  unmount() {
    this.hub.want(false);
    this.voice.stop();
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
    this.hub.close();
    this.voice.stop();
    this.runner.cancelAll();
    if (this.research?.abort) this.research.abort.abort();
  }

  ensureMask() {
    if (this.mask !== undefined) return this.mask;
    try {
      const src = this.app.catalog?.world;
      this.mask = src ? worldMask(decodeWorld(src)) : null;
      if (this.mask) {
        const m = this.mask;
        this.mask = { land: (lon, lat) => m.get(lon, lat) > 0 };
      }
    } catch {
      this.mask = null;
    }
    return this.mask;
  }

  // The app keeps rendering while an explainer plays or a run streams, even with decorative animations off.
  animating() {
    return Boolean((this.mode === 'play' && this.player && !this.player.paused) || this.research?.status === 'running' || this.building);
  }

  finding(id) {
    return this.findings.find((f) => f.id === id) || null;
  }

  get selected() {
    return this.finding(this.selectedId);
  }

  storyboardFor(f) {
    if (!f) return null;
    if (f.demo) return normalizeStoryboard(DEMO_STORYBOARD, f);
    const raw = this.lib.loadExplainer(f.id);
    return raw ? normalizeStoryboard(raw, f) : null;
  }

  // --- research run ----------------------------------------------------------------

  startResearch(topic = '') {
    if (this.research && this.research.status === 'running') {
      this.app.toast('research already running (x cancels)', 2000, 'warn');
      return;
    }
    if (!this.runner.available) {
      this.research = { status: 'error', log: [], topic, startedAt: this.now(), count: 0, error: 'claude not found: install Claude Code and sign in once, then press R again' };
      this.app.toast('local claude not found', 3000, 'bad');
      return;
    }
    const abort = new AbortController();
    const res = { status: 'running', log: [], topic, startedAt: this.now(), count: 0, error: '', cost: 0, abort, text: '', consumed: 0, lastTextAt: 0 };
    this.research = res;
    this.mode = this.player ? this.mode : 'signals';
    const harvest = compactHarvest(this.hub.events());
    const known = this.findings.filter((f) => !f.demo).map((f) => f.title);
    this.log(res, topic ? `▶ research run: ${topic}` : '▶ broad research sweep', 'head');
    this.log(res, `${harvest.length} fresh leads from ${this.hub.status().loaded} live sources handed to ${this.runner.model}`, 'dim');
    this.runner
      .run({
        prompt: researchPrompt({ harvest, topic, known, now: this.now() }),
        system: RESEARCH_SYSTEM,
        tools: ['WebSearch', 'WebFetch'],
        maxTurns: 60,
        signal: abort.signal,
        onEvent: (ev) => this.onResearchEvent(res, ev, topic),
      })
      .then((out) => {
        if (this.research !== res || this.disposed) return;
        this.absorbFindings(res, topic, true);
        res.status = out.ok ? 'done' : 'error';
        res.error = out.ok ? '' : out.error;
        res.cost = out.cost || 0;
        res.endedAt = this.now();
        this.log(res, out.ok ? `■ done: ${res.count} finding${res.count === 1 ? '' : 's'}${out.cost ? ` · $${out.cost.toFixed(2)}` : ''}` : `✗ ${out.error}`, out.ok ? 'head' : 'bad');
        this.lib.logRun({ kind: 'research', topic, ok: out.ok, count: res.count, cost: out.cost, error: out.error, durationMs: out.durationMs });
        this.app.toast(out.ok ? `research done: ${res.count} findings` : `research failed: ${truncate(out.error, 60)}`, 4000, out.ok ? 'info' : 'bad');
        this.app.markDirty();
      });
  }

  cancelResearch() {
    if (this.research?.status === 'running') {
      this.research.abort.abort();
      this.research.status = 'error';
      this.research.error = 'cancelled';
      this.log(this.research, '✗ cancelled', 'bad');
    }
  }

  log(res, text, kind = 'dim') {
    res.log.push({ text: String(text).replace(/\s+/g, ' ').trim(), kind, at: this.now() });
    if (res.log.length > 400) res.log.splice(0, res.log.length - 400);
    this.app.markDirty();
  }

  onResearchEvent(res, ev, topic) {
    if (ev.type === 'text') {
      res.text += ev.text;
      // Narration outside <finding> blocks becomes faint log lines, one per line.
      const open = res.text.lastIndexOf('<finding>');
      const close = res.text.lastIndexOf('</finding>');
      const inFinding = open > close;
      if (!inFinding) {
        const tail = res.text.slice(Math.max(res.consumed, close >= 0 ? close + 10 : 0));
        const parts = tail.split('\n');
        if (parts.length > 1) {
          for (const line of parts.slice(0, -1)) {
            const clean = line.replace(/<\/?finding>/g, '').trim();
            if (clean) this.log(res, clean, 'dim');
          }
          res.consumed = res.text.length - parts[parts.length - 1].length;
        }
      }
      this.absorbFindings(res, topic, false);
    } else if (ev.type === 'tools') {
      for (const t of ev.tools) this.log(res, describeTool(t.name, t.input), 'tool');
    } else if (ev.type === 'status' && ev.rateLimited) {
      this.log(res, '⚠ claude is rate limited', 'bad');
    }
  }

  absorbFindings(res, topic, final) {
    const found = extractFindings(res.text, { addedAt: this.now() });
    const fresh = found.slice(res.count);
    if (!fresh.length) return;
    let added = 0;
    for (const f of fresh) {
      f.topic = topic;
      f.appearedAt = this.now();
      const existing = this.findings.findIndex((x) => !x.demo && x.title.toLowerCase() === f.title.toLowerCase());
      let id = f.id;
      if (existing >= 0) {
        id = this.findings[existing].id;
        this.findings[existing] = { ...this.findings[existing], ...f, id, status: this.findings[existing].status === 'ready' ? 'ready' : 'new' };
      } else {
        this.findings.unshift(f);
        added += 1;
      }
      this.log(res, `◆ ${f.title}`, 'finding');
      this.enqueueBuild(id, false);
    }
    res.count = found.length;
    try {
      this.lib.addFindings(this.findings.filter((f) => !f.demo));
    } catch {
      // the library is best-effort
    }
    if (this.lists.rail.selected > 0) this.lists.rail.selected += added; // keep the cursor on the same row
    void final;
  }

  // --- explainer builds --------------------------------------------------------------

  enqueueBuild(id, priority) {
    const f = this.finding(id);
    if (!f || f.demo || f.status === 'ready') return;
    if (this.building === id) return;
    const b = this.builds.get(id) || { status: 'queued', startedAt: 0, scenes: 0, error: '', log: [], attempts: 0 };
    b.status = 'queued';
    this.builds.set(id, b);
    f.status = 'queued';
    this.queue = this.queue.filter((x) => x !== id);
    if (priority) this.queue.unshift(id);
    else this.queue.push(id);
    this.pumpBuilds();
  }

  pumpBuilds() {
    if (this.disposed || this.building || !this.queue.length) return;
    if (!this.runner.available) {
      for (const id of this.queue) {
        const f = this.finding(id);
        if (f) f.status = 'new';
        const b = this.builds.get(id);
        if (b) {
          b.status = 'error';
          b.error = 'claude not found';
        }
      }
      this.queue = [];
      return;
    }
    const id = this.queue.shift();
    const f = this.finding(id);
    if (!f) return this.pumpBuilds();
    const b = this.builds.get(id);
    b.status = 'building';
    b.startedAt = this.now();
    b.scenes = 0;
    b.text = '';
    f.status = 'building';
    this.building = id;
    this.app.markDirty();
    this.runBuild(f, b, storyboardPrompt(f, { now: this.now() }), STORYBOARD_SYSTEM)
      .catch((err) => {
        // A bad answer or a full disk fails this explainer only.
        b.status = 'error';
        b.error = err && err.message ? err.message : String(err);
        f.status = 'new';
        this.app.toast(`explainer failed: ${truncate(b.error, 60)}`, 4000, 'bad');
      })
      .finally(() => {
        this.building = null;
        this.app.markDirty();
        this.pumpBuilds();
      });
  }

  async runBuild(f, b, prompt, system) {
    const out = await this.runner.run({
      prompt,
      system,
      tools: [],
      maxTurns: 1,
      onEvent: (ev) => {
        if (ev.type === 'text') {
          b.text += ev.text;
          const n = (b.text.match(/"narration"\s*:/g) || []).length;
          if (n !== b.scenes) {
            b.scenes = n;
            this.app.markDirty();
          }
        }
      },
    });
    if (this.disposed) return;
    if (!out.ok) {
      b.status = 'error';
      b.error = out.error;
      f.status = 'new';
      this.lib.logRun({ kind: 'explainer', id: f.id, ok: false, error: out.error });
      this.app.toast(`explainer failed: ${truncate(out.error, 60)}`, 4000, 'bad');
      return;
    }
    const json = extractJson(out.text);
    let sb;
    try {
      sb = normalizeStoryboard(json || {}, f);
    } catch (err) {
      throw new Error(`the writer's JSON could not be read: ${err.message}`);
    }
    sb.model = this.runner.model;
    const problems = validateStoryboard(sb);
    if (problems.length > 3 && b.attempts < 1 && json) {
      b.attempts += 1;
      b.scenes = 0;
      this.app.toast(`repairing explainer (${problems.length} problems)`, 3000, 'warn');
      return this.runBuild(f, b, repairPrompt(problems, JSON.stringify(json)), system);
    }
    if (!sb.scenes.length) {
      b.status = 'error';
      b.error = 'the writer returned no scenes';
      f.status = 'new';
      return;
    }
    sb.problems = problems;
    this.lib.saveExplainer(f.id, sb);
    this.lib.logRun({ kind: 'explainer', id: f.id, ok: true, scenes: sb.scenes.length, cost: out.cost, durationMs: out.durationMs, problems: problems.length });
    b.status = 'ready';
    f.status = 'ready';
    f.builtAt = this.now();
    try {
      this.lib.addFindings(this.findings.filter((x) => !x.demo));
    } catch {
      // best-effort
    }
    if (this.selectedId === f.id) this.play(f);
    this.app.toast(`explainer ready: ${truncate(f.title, 50)}`, 3000);
    this.app.markDirty();
  }

  // --- playback ---------------------------------------------------------------------

  open(f) {
    if (!f) return;
    this.selectedId = f.id;
    this.focusPane('stage');
    if (f.status === 'ready' || f.demo) return this.play(f);
    this.voice.stop();
    this.mode = 'compiling';
    this.player = null;
    this.enqueueBuild(f.id, true);
  }

  savePhenomenaPrefs() {
    if (!this.app.prefs) return;
    this.app.prefs.phenomena = { ...(this.app.prefs.phenomena || {}), voice: this.voiceOn, speed: this.speedPref };
    this.app.savePrefs(this.app.prefs);
  }

  pace() {
    return this.voiceOn && this.voice.available ? VOICE_MS_PER_CHAR : NARRATION_MS_PER_CHAR;
  }

  setSpeed(k) {
    const p = this.player;
    this.speedPref = Math.max(0.25, Math.min(4, k));
    if (p) p.setSpeed(this.speedPref);
    this.voice.stop(); // re-spoken at the new rate from the typed position
    this.savePhenomenaPrefs();
    this.app.toast(`speed ×${this.speedPref.toFixed(2)}${this.speedPref < 1 ? ' (slower)' : this.speedPref > 1 ? ' (faster)' : ''}`);
  }

  stepSpeed(dir) {
    const i = SPEEDS.findIndex((v) => Math.abs(v - this.speedPref) < 0.01);
    const next = i < 0 ? (dir > 0 ? SPEEDS.find((v) => v > this.speedPref) : [...SPEEDS].reverse().find((v) => v < this.speedPref)) : SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + dir))];
    this.setSpeed(next || this.speedPref);
  }

  toggleVoice() {
    this.voiceOn = !this.voiceOn;
    if (!this.voiceOn) this.voice.stop();
    if (this.player) this.player.pace = this.pace();
    this.savePhenomenaPrefs();
    this.app.toast(this.voiceOn ? (this.voice.available ? 'voice on' : 'voice on, but no speech engine found (say / espeak-ng)') : 'voice off', 2500, this.voiceOn && !this.voice.available ? 'warn' : 'info');
  }

  // Keep speech aligned with the scene: speak on entry, stop on pause, resume from the typed position.
  syncVoice(p, sc, tScene) {
    if (!this.voiceOn || !this.voice.available) {
      if (this.voice.speaking) this.voice.stop();
      return;
    }
    const key = `${p.sb.id}:${sc.id}:${p.startedAt}`;
    if (p.paused) {
      if (this.voice.speaking) this.voice.stop();
      return;
    }
    if (this.voice.currentKey === key) return;
    const from = tScene > 1.5 ? Math.min(sc.narration.length, Math.floor((tScene * 1000) / p.pace)) : 0;
    const text = from > 0 ? sc.narration.slice(from).replace(/^\S*\s/, '') : `${sc.title}. ${sc.narration}`;
    this.voice.speak(text, { key, rate: p.speed });
  }

  play(f) {
    const sb = this.storyboardFor(f);
    if (!sb || !sb.scenes.length) {
      this.mode = 'compiling';
      this.enqueueBuild(f.id, true);
      return;
    }
    this.voice.stop();
    this.player = new Player(sb, { now: this.now });
    this.player.speed = this.speedPref;
    this.player.pace = this.pace();
    this.player.hold = () => this.voiceOn && this.voice.speaking;
    this.mode = 'play';
    this.narrationKey = '';
    this.app.markDirty();
  }

  showSignals() {
    this.voice.stop();
    this.mode = 'signals';
    this.player = null;
    this.selectedId = null;
  }

  ask(question) {
    const f = this.selected;
    const sb = this.player?.sb;
    if (!f || !sb || !question.trim()) return;
    if (!this.runner.available) return this.app.toast('local claude not found', 2500, 'bad');
    const q = question.trim();
    const player = this.player;
    this.app.toast(`asking: ${truncate(q, 60)}`, 2500);
    this.runner.run({ prompt: askPrompt(sb, q), system: ASK_SYSTEM, tools: [], maxTurns: 1 }).then((out) => {
      if (this.disposed) return;
      if (!out.ok) return this.app.toast(`ask failed: ${truncate(out.error, 60)}`, 4000, 'bad');
      const json = extractJson(out.text) || {};
      const scenes = Array.isArray(json.scenes) ? json.scenes.map((s, i) => normalizeScene(s, sb.scenes.length + i)) : [];
      for (const s of scenes) s.title = s.title.startsWith('Q:') ? s.title : `Q: ${s.title}`;
      if (!f.demo) {
        try {
          const raw = this.lib.loadExplainer(f.id) || sb;
          raw.scenes = [...(raw.scenes || []), ...scenes];
          raw.qa = [...(raw.qa || []), { question: q, answer: String(json.answer || ''), at: this.now() }];
          this.lib.saveExplainer(f.id, raw);
        } catch {
          this.app.toast('could not save the answer to disk', 3000, 'warn');
        }
      }
      sb.scenes.push(...scenes);
      sb.totalS = sb.scenes.reduce((a, s) => a + s.duration, 0);
      const answer = String(json.answer || '').trim();
      this.app.openDetail({ title: `Q: ${q}`, subtitle: f.title, rows: scenes.length ? [['New scenes', scenes.map((s) => s.title).join(' · ')]] : [], body: answer || 'No answer text; see the new scenes.' });
      if (this.player === player && player && scenes.length) player.seek(sb.scenes.length - scenes.length);
      this.app.markDirty();
    });
  }

  // --- details ------------------------------------------------------------------------

  mapView() {
    return this.app.views.find((v) => v.id === 'map') || null;
  }

  centerSpec(loc) {
    const mv = this.mapView();
    if (!mv || !loc) return {};
    return { onCenter: () => mv.centerOn({ lon: loc.lon, lat: loc.lat, name: loc.name }, 4) };
  }

  describeFinding(f) {
    const rows = [];
    if (f.field) rows.push(['Field', f.field]);
    if (f.date) rows.push(['Date', f.date]);
    if (f.hook) rows.push(['Hook', f.hook]);
    rows.push(['Status', f.demo ? 'built-in demo explainer' : f.status]);
    if (f.secrecy?.level && f.secrecy.level !== 'public') rows.push(['Secrecy', `${f.secrecy.level}${f.secrecy.notes ? `: ${f.secrecy.notes}` : ''}`]);
    if (Number.isFinite(f.confidence)) rows.push(['Confidence', `${Math.round(f.confidence * 100)}%`]);
    if (f.people?.length) rows.push(['People', f.people.map((p) => `${p.name}${p.role ? ` (${p.role})` : ''}`).join('; ')]);
    if (f.locations?.length) rows.push(['Where', f.locations.map((l) => `${l.name} ${l.lat.toFixed(2)}, ${l.lon.toFixed(2)}`).join('; ')]);
    if (f.tags?.length) rows.push(['Tags', f.tags.join(', ')]);
    (f.sources || []).forEach((s, i) => rows.push([`Source ${i + 1}`, `${s.title} ${s.url}`]));
    const body = [f.summary, f.why ? `Why it matters: ${f.why}` : ''].filter(Boolean).join('\n\n');
    return { title: f.title, subtitle: `finding · ${f.topic || 'broad sweep'}`, rows, body, url: (f.sources || []).map((s) => s.url).find(isHttpUrl) || null, ...this.centerSpec(f.locations?.[0]) };
  }

  describeScene() {
    const p = this.player;
    const s = p?.scene;
    if (!s) return null;
    const sb = p.sb;
    const rows = [['Scene', `${p.index + 1} of ${p.count} · ${Math.round(s.duration)} s`], ['Kicker', s.kicker || '']];
    s.callouts.forEach((c, i) => rows.push([`Callout ${i + 1}`, `${c.target ? `→ ${c.target}: ` : ''}${c.text}`]));
    if (s.equation) rows.push(['Equation', `${s.equation.expr}  —  ${s.equation.meaning}`]);
    if (s.card) rows.push([s.card.kind === 'person' ? 'Who' : 'Card', [s.card.who, s.card.years, s.card.title, s.card.value && `${s.card.value} ${s.card.unit}`, ...s.card.lines].filter(Boolean).join(' · ')]);
    if (s.chart) rows.push(['Chart', `${s.chart.type}: ${s.chart.title}`]);
    if (s.location) rows.push(['Location', `${s.location.name} ${s.location.lat.toFixed(2)}, ${s.location.lon.toFixed(2)}`]);
    const srcs = s.sources.length ? s.sources : sb.meta.sources;
    srcs.slice(0, 8).forEach((x, i) => rows.push([`Source ${i + 1}`, `${x.title} ${x.url}`]));
    return { title: s.title, subtitle: sb.title, rows, body: s.narration, url: srcs.map((x) => x.url).find(isHttpUrl) || null, ...this.centerSpec(s.location) };
  }

  describeStory() {
    const sb = this.player?.sb;
    if (!sb) return null;
    const m = sb.meta;
    const rows = [['Field', sb.field], ['Scenes', `${sb.scenes.length} · ${Math.round(sb.totalS / 60)} min`], ['Secrecy', `${m.secrecy.level}${m.secrecy.notes ? `: ${m.secrecy.notes}` : ''}`]];
    if (m.coveredUp) rows.push(['Covered up', m.coveredUp]);
    m.people.forEach((p) => rows.push([`${p.name}${p.years ? ` (${p.years})` : ''}`, `${p.role}${p.note ? `. ${p.note}` : ''}`]));
    m.timeline.forEach((t) => rows.push([t.year, t.text]));
    m.math.forEach((x) => rows.push([x.name || 'Math', `${x.expr}  —  ${x.meaning}`]));
    m.uses.forEach((u, i) => rows.push([`Use ${i + 1}`, u]));
    m.glossary.forEach((g) => rows.push([g.term, g.meaning]));
    m.locations.forEach((l) => rows.push([l.name, `${l.lat.toFixed(2)}, ${l.lon.toFixed(2)}${l.note ? ` · ${l.note}` : ''}`]));
    m.sources.forEach((s, i) => rows.push([`Source ${i + 1}`, `${s.title} ${s.url}`]));
    return { title: sb.title, subtitle: `explainer · ${sb.model || 'built-in'}`, rows, body: sb.summary, url: m.sources.map((x) => x.url).find(isHttpUrl) || null, ...this.centerSpec(m.locations[0]) };
  }

  describeOverlap(o) {
    return { title: `${fmtGap(o.gapMs)} apart`, subtitle: 'cross-source coincidence', rows: [['First', `${o.a.sourceLabel}: ${o.a.title}`], ['When', new Date(o.a.at).toISOString().replace('T', ' ').slice(0, 16)], ['Then', `${o.b.sourceLabel}: ${o.b.title}`], ['When', new Date(o.b.at).toISOString().replace('T', ' ').slice(0, 16)], ['Score', o.score.toFixed(2)], ['Link 1', o.a.url || ''], ['Link 2', o.b.url || '']], body: `${o.a.summary || ''}\n\n${o.b.summary || ''}`, url: [o.a.url, o.b.url].find(isHttpUrl) || null, ...this.centerSpec(Number.isFinite(o.a.lat) ? o.a : Number.isFinite(o.b.lat) ? o.b : null) };
  }

  describeSources() {
    const st = this.hub.status();
    const rows = [];
    for (const gid of Object.keys(GROUPS)) {
      const rowsIn = st.rows.filter((r) => r.group === gid);
      if (!rowsIn.length) continue;
      rows.push([GROUPS[gid].label.toUpperCase(), GROUPS[gid].hint]);
      for (const r of rowsIn) rows.push([r.label, `${r.error ? `error: ${r.error}` : r.loadedAt ? `${r.count} items · ${ageOf(r.loadedAt, this.now())} ago` : r.loading ? 'loading' : 'waiting'} · ${r.home}`]);
    }
    return { title: 'Tracked sources', subtitle: `${st.loaded} of ${st.total} loaded · ${st.errors} errors`, rows, body: 'Every source is fetched directly from your machine with no account or key. Research runs hand the freshest items to the local Claude as leads.' };
  }

  // --- pane plumbing ----------------------------------------------------------------

  items(pane) {
    if (pane === 'rail') return this.findings;
    if (pane === 'stage' && this.mode === 'signals') return this.overlapsNow();
    return null;
  }

  describe(item, pane) {
    if (pane === 'rail') return this.describeFinding(item);
    if (pane === 'stage' && this.mode === 'signals') return this.describeOverlap(item);
    return null;
  }

  activate(pane) {
    if (pane === 'rail') {
      const f = selectedItem(this.lists.rail, this.findings);
      if (f) this.open(f);
      return;
    }
    if (this.mode === 'play') {
      const spec = this.describeScene();
      if (spec) this.app.openDetail(spec);
      return;
    }
    super.activate(pane);
  }

  selectedUrl() {
    if (this.focusedPane === 'stage' && this.mode === 'play') return this.describeScene()?.url || null;
    if (this.focusedPane === 'stage' && this.mode === 'signals') {
      const o = selectedItem(this.lists.stage, this.overlapsNow());
      return o ? this.describeOverlap(o).url : null;
    }
    const f = selectedItem(this.lists.rail, this.findings);
    return f ? this.describeFinding(f).url : null;
  }

  overlapsNow() {
    const now = this.now();
    if (this.ovCache && now - this.ovCache.at < 15000 && this.ovCache.n === this.hub.events().length) return this.ovCache.list;
    const list = overlaps(this.hub.events(), { now });
    this.ovCache = { at: now, n: this.hub.events().length, list };
    return list;
  }

  hints() {
    if (this.prompter) return 'type · Enter run · Esc cancel';
    if (this.focusedPane === 'stage' && this.mode === 'play') return 'space pause  ←→ scenes  [ ] slower/faster  v voice  ↑↓ scrub  Enter expand  i story  a ask  m map';
    if (this.focusedPane === 'stage') return 'R research  + topic  Enter expand  s sources';
    return 'Enter open  i info  R research  + topic  d delete  S signals';
  }

  onKey(ev) {
    if (this.prompter) return this.onPrompterKey(ev);
    const playing = this.mode === 'play' && this.player;
    switch (ev.name) {
      case 'R':
        this.startResearch('');
        return true;
      case '+':
      case '=':
        if (ev.name === '=' && playing) break;
        this.prompter = { kind: 'topic', text: '' };
        return true;
      case 'S':
        this.showSignals();
        return true;
      case 'x':
        this.cancelResearch();
        return true;
      case 's':
        if (playing) {
          const spec = this.describeStory();
          if (spec) this.app.openDetail(spec);
        } else this.app.openDetail(this.describeSources());
        return true;
      case 'i': {
        if (playing && this.focusedPane === 'stage') {
          const spec = this.describeStory();
          if (spec) this.app.openDetail(spec);
          return true;
        }
        const f = selectedItem(this.lists.rail, this.findings);
        if (f) this.app.openDetail(this.describeFinding(f));
        return true;
      }
      case 'd': {
        if (this.focusedPane !== 'rail') break;
        const f = selectedItem(this.lists.rail, this.findings);
        if (!f || f.demo) return true;
        this.findings = this.findings.filter((x) => x.id !== f.id);
        try {
          this.lib.removeFinding(f.id);
        } catch {
          // best-effort
        }
        if (this.selectedId === f.id) this.showSignals();
        this.app.toast(`removed: ${truncate(f.title, 50)}`);
        return true;
      }
      default:
        break;
    }
    if (playing && (this.focusedPane === 'stage' || ['space', 'left', 'right'].includes(ev.name))) {
      const p = this.player;
      switch (ev.name) {
        case 'space':
          p.togglePause();
          return true;
        case 'right':
          p.next();
          return true;
        case 'left':
          p.prev();
          return true;
        case 'up':
          p.scrub(5);
          return true;
        case 'down':
          p.scrub(-5);
          return true;
        case 'home':
        case '0':
          p.restart();
          return true;
        case 'a':
          this.prompter = { kind: 'ask', text: '' };
          return true;
        case 'L':
          p.loop = !p.loop;
          this.app.toast(p.loop ? 'loop on' : 'loop off');
          return true;
        case '[':
        case '-':
          this.stepSpeed(-1);
          return true;
        case ']':
        case '=':
          this.stepSpeed(1);
          return true;
        case 'v':
          this.toggleVoice();
          return true;
        case 'm': {
          const loc = p.scene?.location || p.sb.meta.locations[0];
          const mv = this.mapView();
          if (loc && mv) {
            this.app.switchView(this.app.views.indexOf(mv));
            mv.centerOn({ lon: loc.lon, lat: loc.lat, name: loc.name }, 4);
          } else this.app.toast('no location in this scene', 1500, 'warn');
          return true;
        }
        case 'enter':
          this.activate('stage');
          return true;
        default:
          break;
      }
    }
    if (ev.name === 'escape' && this.mode !== 'signals') {
      this.showSignals();
      this.focusPane('rail');
      return true;
    }
    return super.onKey(ev);
  }

  onPrompterKey(ev) {
    const p = this.prompter;
    if (ev.name === 'escape') this.prompter = null;
    else if (ev.name === 'enter') {
      const text = p.text.trim();
      this.prompter = null;
      if (!text) return true;
      if (p.kind === 'topic') this.startResearch(text);
      else this.ask(text);
    } else if (ev.name === 'backspace') p.text = p.text.slice(0, -1);
    else if (ev.name === 'space') p.text += ' ';
    else if (ev.ch && !ev.ctrl && ev.name !== 'tab') p.text += ev.ch;
    return true;
  }

  onMouse(ev) {
    if (!this.player || this.mode !== 'play' || !this.stageRect) return false;
    const r = this.stageRect;
    const inside = ev.x >= r.x && ev.x < r.x + r.w && ev.y >= r.y && ev.y < r.y + r.h;
    if (!inside) return false;
    if (ev.kind === 'wheelup' || ev.kind === 'wheeldown') {
      this.player.scrub(ev.kind === 'wheelup' ? -5 : 5);
      return true;
    }
    if (ev.kind === 'down' && ev.button === 0) {
      this.focusPane('stage');
      this.player.togglePause();
      return true;
    }
    return false;
  }

  // --- rendering --------------------------------------------------------------------

  render(ctx, r) {
    const wide = r.w >= 100;
    const [left, right] = wide ? splitH(r, [Math.max(34, Math.round(r.w * 0.34)), 'fill']) : splitV(r, ['42%', 'fill']);
    this.renderRail(ctx, left);
    this.renderStage(ctx, right);
    if (this.prompter) this.renderPrompter(ctx, r);
  }

  renderRail(ctx, r) {
    const { s, t, now } = ctx;
    const res = this.research;
    const running = res?.status === 'running';
    const inner = panel(ctx, r, { title: 'Phenomena', focused: this.isFocused('rail'), right: `${this.findings.length} findings`, badge: running ? 'RESEARCHING' : 'AI', badgeColor: running ? t.accent2 : t.accent3, onClick: () => this.focusPane('rail') });
    if (inner.w < 14 || inner.h < 5) return;
    let y = inner.y;
    // toolbar
    let x = inner.x;
    x += button(ctx, x, y, running ? '■ STOP' : '▶ RUN RESEARCH', { active: !running, onClick: () => (running ? this.cancelResearch() : this.startResearch('')) }) + 1;
    x += button(ctx, x, y, '+ TOPIC', { onClick: () => (this.prompter = { kind: 'topic', text: '' }) }) + 1;
    if (x + 11 <= inner.x + inner.w) x += button(ctx, x, y, '◉ SIGNALS', { active: this.mode === 'signals', onClick: () => this.showSignals() }) + 1;
    y += 1;
    const st = this.hub.status();
    const claude = this.runner.available ? `${this.runner.model} · local claude` : 'claude not found';
    s.text(inner.x, y++, truncate(`${st.loaded}/${st.total} sources${st.errors ? ` · ${st.errors} err` : ''} · ${claude}`, inner.w), { fg: this.runner.available ? t.dim : t.warn, bg: t.panel });
    // research log
    if (res && (running || now - (res.endedAt || 0) < 20000 || res.status === 'error')) {
      const logH = Math.min(running ? 7 : 3, Math.max(2, Math.floor(inner.h * 0.3)));
      heading(ctx, inner.x, y++, running ? `research ${spinner(now)}` : res.status === 'error' ? 'research stopped' : 'research done', inner.w);
      const lines = res.log.slice(-logH);
      lines.forEach((l, i) => {
        const last = i === lines.length - 1 && running;
        const age = now - l.at;
        let text = l.text;
        if (last && this.app.anim) text = text.slice(0, Math.max(0, Math.floor(age / 14)));
        const fg = l.kind === 'finding' ? t.accent : l.kind === 'head' ? t.text : l.kind === 'tool' ? t.info : l.kind === 'bad' ? t.bad : mix(t.panel, t.dim, 0.85);
        s.text(inner.x, y, truncate(text, inner.w - 1), { fg, bg: t.panel, attr: l.kind === 'finding' ? ATTR.BOLD : 0 });
        if (last && this.app.anim && Math.floor(now / 300) % 2 === 0) s.put(inner.x + Math.min(inner.w - 1, strWidth(truncate(text, inner.w - 1))), y, '▌', { fg: t.accent, bg: t.panel });
        y += 1;
      });
      if (res.status === 'error' && res.error && !lines.some((l) => l.kind === 'bad')) s.text(inner.x, y++, truncate(`✗ ${res.error}`, inner.w), { fg: t.bad, bg: t.panel });
    }
    heading(ctx, inner.x, y++, 'headlines', inner.w);
    const listR = rect(inner.x, y, inner.w, Math.max(1, inner.y + inner.h - y));
    const rowH = inner.w >= 44 ? 3 : 4;
    this.lists.rail.draw(
      ctx,
      listR,
      this.findings,
      (f, _i, { selected, width }) => {
        const g = f.demo ? '◈' : f.secrecy?.level && f.secrecy.level !== 'public' ? SECRECY_GLYPH[f.secrecy.level] || '▣' : '◆';
        const gColor = f.secrecy?.level === 'contested' ? t.warn : f.secrecy?.level && f.secrecy.level !== 'public' ? t.accent2 : f.demo ? t.accent3 : t.accent;
        const born = f.appearedAt ? now - f.appearedAt : Infinity;
        const title = this.app.anim && born >= 0 && born < 900 ? materialize(f.title, born / 900, now) : f.title;
        const lines = wrap(title, Math.max(8, width - 3));
        const b = this.builds.get(f.id);
        const status = f.demo ? 'BUILT-IN' : f.status === 'ready' ? 'READY' : f.status === 'building' ? `WRITING ${b?.scenes || 0} scenes ${spinner(now)}` : f.status === 'queued' ? 'QUEUED' : 'NEW';
        const sColor = f.status === 'ready' || f.demo ? t.good : f.status === 'building' ? t.accent2 : f.status === 'queued' ? t.warn : t.dim;
        const isActive = f.id === this.selectedId;
        const rows = [[
          { text: `${g} `, fg: selected ? t.selText : gColor, attr: ATTR.BOLD },
          { text: lines[0] || '', fg: selected ? t.selText : isActive ? t.accent : t.text, attr: isActive ? ATTR.BOLD : 0 },
        ]];
        for (let k = 1; k < rowH - 1; k++) rows.push([{ text: '  ' }, { text: k === rowH - 2 && lines.length > rowH - 1 ? `${(lines[k] || '').slice(0, Math.max(0, width - 4))}…` : lines[k] || '', fg: selected ? t.selText : isActive ? t.accent : t.text }]);
        const meta = [f.field, f.date].filter(Boolean).join(' · ');
        rows.push([{ text: '  ' }, { text: status, fg: selected ? t.selText : sColor, attr: ATTR.BOLD }, { text: meta ? `  ${meta}` : '', fg: selected ? t.selText : t.dim }]);
        return rows;
      },
      this.listOpts('rail', { rowHeight: rowH, empty: 'press R to research' }),
    );
    void label;
  }

  renderStage(ctx, r) {
    if (this.mode === 'play' && this.player) return this.renderPlayer(ctx, r);
    if (this.mode === 'compiling') return this.renderCompiling(ctx, r);
    return this.renderSignals(ctx, r);
  }

  renderCompiling(ctx, r) {
    const { s, t, now } = ctx;
    this.drawing.add('stage'); // no list here, but the pane is on screen and focusable
    const f = this.selected;
    const b = f ? this.builds.get(f.id) : null;
    const inner = panel(ctx, r, { title: f ? f.title : 'Explainer', focused: this.isFocused('stage'), badge: 'WRITING', badgeColor: t.accent2, onClick: () => this.focusPane('stage') });
    if (inner.w < 20 || inner.h < 6) return;
    const cx = inner.x + Math.floor(inner.w / 2);
    let y = inner.y + 1;
    const title = b?.status === 'error' ? 'EXPLAINER FAILED' : b?.status === 'queued' ? 'QUEUED BEHIND ANOTHER EXPLAINER' : 'COMPILING EXPLAINER';
    s.text(cx - Math.floor(strWidth(title) / 2), y++, title, { fg: b?.status === 'error' ? t.bad : t.accent, bg: t.panel, attr: ATTR.BOLD });
    y++;
    const elapsed = b?.startedAt ? Math.floor((now - b.startedAt) / 1000) : 0;
    const scenes = b?.scenes || 0;
    const ratio = Math.min(0.95, scenes / 14);
    const gw = Math.min(60, inner.w - 4);
    gauge(ctx, cx - Math.floor(gw / 2), y++, gw, b?.status === 'building' ? Math.max(0.03, ratio) : 0, { fg: t.accent2 });
    const line = b?.status === 'error' ? b.error : b?.status === 'building' ? `${this.runner.model} is writing scene ${scenes + 1} · ${fmtTime(elapsed)} elapsed · this takes a few minutes` : b?.status === 'queued' ? `in line: ${this.queue.indexOf(f?.id) + 1} ahead` : 'waiting';
    s.text(cx - Math.floor(Math.min(inner.w - 2, strWidth(line)) / 2), y++, truncate(line, inner.w - 2), { fg: b?.status === 'error' ? t.bad : t.dim, bg: t.panel });
    y++;
    // ascii "thinking" field
    const fieldH = Math.max(3, Math.min(8, inner.h - (y - inner.y) - 8));
    const canvas = new DotCanvas(inner.w - 2, fieldH);
    for (let i = 0; i < 160; i++) {
      const px = (i / 160) * canvas.w;
      const ph = (now / 900 + i * 0.13) % (Math.PI * 2);
      const py = canvas.h / 2 + Math.sin(ph) * (canvas.h / 3) * Math.sin(i / 9 + now / 1500);
      canvas.dot(px, py, mix(t.panel, t.accent2, 0.3 + 0.7 * pulse(now, 1400, i / 20)), 1);
    }
    canvas.blit(ctx, rect(inner.x + 1, y, inner.w - 2, fieldH));
    y += fieldH + 1;
    if (f) {
      heading(ctx, inner.x, y++, 'while you wait', inner.w);
      for (const l of wrap([f.hook, f.summary].filter(Boolean).join(' '), inner.w).slice(0, Math.max(0, inner.y + inner.h - y - 1))) s.text(inner.x, y++, l, { fg: t.text, bg: t.panel });
    }
    if (b?.status === 'error' && f) {
      const bx = inner.x;
      button(ctx, bx, inner.y + inner.h - 1, '↻ RETRY', { onClick: () => this.enqueueBuild(f.id, true) });
    }
  }

  renderPlayer(ctx, r) {
    const { s, t, now } = ctx;
    this.drawing.add('stage');
    const p = this.player;
    p.tick(now);
    const sc = p.scene;
    const sb = p.sb;
    const prog = p.progress(now);
    const inner = panel(ctx, r, { title: sb.title, focused: this.isFocused('stage'), right: `${prog.index + 1}/${prog.total} · ${fmtTime(Math.round(prog.remainingS))} left`, badge: p.paused ? 'PAUSED' : 'PLAYING', badgeColor: p.paused ? t.warn : t.accent, onClick: () => this.focusPane('stage') });
    if (inner.w < 30 || inner.h < 10 || !sc) return;
    // scene header
    let y = inner.y;
    s.text(inner.x, y, truncate(`${String(prog.index + 1).padStart(2, '0')} ${sc.title.toUpperCase()}`, inner.w), { fg: t.accent, bg: t.panel, attr: ATTR.BOLD });
    const kick = truncate(sc.kicker || '', Math.max(0, inner.w - strWidth(sc.title) - 6));
    if (kick) s.text(inner.x + inner.w - strWidth(kick), y, kick, { fg: t.dim, bg: t.panel });
    y += 1;
    const narrH = Math.max(3, Math.min(7, Math.floor(inner.h * 0.24)));
    const stageH = inner.h - 1 - narrH - 1;
    const stage = rect(inner.x, y, inner.w, stageH);
    this.stageRect = stage;
    if (!this.canvas || this.canvas.cols !== stage.w || this.canvas.rows !== stage.h) this.canvas = new DotCanvas(stage.w, stage.h);
    const tScene = p.time(now);
    this.syncVoice(p, sc, tScene);
    const callout = p.activeCallout(tScene);
    renderScene(this.canvas, sc, tScene, { theme: t, mask: this.ensureMask(), callout, anim: this.app.anim });
    this.canvas.blit(ctx, stage);
    hit(ctx, stage, { onClick: () => p.togglePause(), onWheel: (dir) => p.scrub(dir * 5) });
    y += stageH;
    // narration, typed
    const key = `${sb.id}:${sc.id}`;
    if (this.narrationKey !== key) {
      this.narrationKey = key;
      this.narrationStartedAt = p.startedAt;
    }
    const chars = this.app.anim ? Math.floor((tScene * 1000) / p.pace) : Infinity;
    const typed = sc.narration.slice(0, chars);
    const lines = wrap(typed, inner.w - 2);
    const visible = lines.slice(Math.max(0, lines.length - narrH));
    s.fill(rect(inner.x, y, inner.w, narrH), ' ', { bg: t.panel });
    s.put(inner.x, y, '▍', { fg: t.accent, bg: t.panel });
    visible.forEach((l, i) => s.text(inner.x + 2, y + i, l, { fg: t.text, bg: t.panel }));
    if (chars < sc.narration.length && Math.floor(now / 350) % 2 === 0) s.put(inner.x + 2 + strWidth(visible[visible.length - 1] || ''), y + Math.max(0, visible.length - 1), '▌', { fg: t.accent, bg: t.panel });
    y += narrH;
    // progress bar: scene ticks, with the current scene filling
    const bar = rect(inner.x, y, inner.w, 1);
    s.fill(bar, ' ', { bg: t.panel });
    const total = Math.max(1, sb.totalS);
    let bx = inner.x;
    sb.scenes.forEach((x, i) => {
      const w = Math.max(1, Math.round((x.duration / total) * (inner.w - 1)));
      const done = i < prog.index;
      const cur = i === prog.index;
      for (let k = 0; k < w && bx + k < inner.x + inner.w - 1; k++) {
        const fill = done || (cur && k / w < prog.sceneRatio);
        s.put(bx + k, y, fill ? '━' : '─', { fg: fill ? (cur ? t.accent : mix(t.panel, t.accent, 0.6)) : t.muted, bg: t.panel });
      }
      hit(ctx, rect(bx, y, w, 1), { onClick: () => p.seek(i) });
      bx += w;
    });
    // transport: speed and voice controls, clickable
    const tag = `${fmtTime(Math.floor(tScene))}/${fmtTime(Math.round(prog.duration))}${p.loop ? '' : ' ⟲off'} `;
    let tx = inner.x + inner.w - strWidth(tag);
    s.text(tx, y, tag, { fg: t.dim, bg: t.panel });
    const speedTag = `×${p.speed.toFixed(2).replace(/\.?0+$/, '')}`;
    const controls = [
      { text: ' − ', onClick: () => this.stepSpeed(-1), fg: t.accent },
      { text: speedTag, onClick: () => this.setSpeed(1), fg: p.speed === 1 ? t.dim : t.warn },
      { text: ' + ', onClick: () => this.stepSpeed(1), fg: t.accent },
      { text: ` ${this.voiceOn ? '♪ VOICE' : '♪ MUTE'} `, onClick: () => this.toggleVoice(), fg: this.voiceOn ? (this.voice.available ? t.good : t.warn) : t.dim },
      { text: p.paused ? ' ▶ ' : ' ‖ ', onClick: () => p.togglePause(), fg: t.accent },
    ];
    tx -= controls.reduce((a, c) => a + strWidth(c.text), 0) + 1;
    for (const c of controls) {
      s.text(tx, y, c.text, { fg: c.fg, bg: t.muted, attr: ATTR.BOLD });
      hit(ctx, rect(tx, y, strWidth(c.text), 1), { onClick: c.onClick });
      tx += strWidth(c.text);
    }
  }

  renderSignals(ctx, r) {
    const { s, t, now } = ctx;
    const sigs = this.hub.signals();
    const comp = composite(sigs, { now, spanMs: 24 * 3600000, n: Math.max(60, (r.w - 4) * 2) });
    const level = noiseLevel(comp);
    const inner = panel(ctx, r, { title: 'Global signal noise', focused: this.isFocused('stage'), right: `${this.hub.events().length} events · 24 h`, badge: level.label, badgeColor: level.label === 'ELEVATED' ? t.bad : level.label === 'ACTIVE' ? t.warn : t.good, onClick: () => this.focusPane('stage') });
    if (inner.w < 30 || inner.h < 10) return;
    const [scopeR, heatR, coR] = splitV(inner, ['40%', Math.min(16, Object.keys(GROUPS).length + 3), 'fill']);
    // --- oscilloscope
    const legendW = Math.min(26, Math.floor(scopeR.w * 0.32));
    const plot = rect(scopeR.x, scopeR.y, scopeR.w - legendW - 1, scopeR.h - 1);
    const canvas = new DotCanvas(plot.w, plot.h);
    for (let gy = 1; gy < 4; gy++) canvas.line(0, (canvas.h * gy) / 4, canvas.w - 1, (canvas.h * gy) / 4, mix(t.panel, t.border, 0.7), -5, 2);
    for (let gx = 1; gx < 6; gx++) canvas.line((canvas.w * gx) / 6, 0, (canvas.w * gx) / 6, canvas.h - 1, mix(t.panel, t.border, 0.7), -5, 2);
    const pts = comp.samples.map((smp, i) => [(i / (comp.samples.length - 1)) * (canvas.w - 1), canvas.h - 1 - smp.value * (canvas.h - 1)]);
    // Individual contributors as faint traces, composite bright on top.
    for (const c of comp.contributors) {
      const tr = comp.samples.map((smp, i) => (smp.parts[c.id] === undefined ? null : [(i / (comp.samples.length - 1)) * (canvas.w - 1), canvas.h - 1 - smp.parts[c.id] * (canvas.h - 1)]));
      for (let i = 0; i + 1 < tr.length; i++) if (tr[i] && tr[i + 1]) canvas.line(tr[i][0], tr[i][1], tr[i + 1][0], tr[i + 1][1], mix(t.panel, t.info, 0.35), 1);
    }
    const sweep = this.app.anim ? (now / 40) % canvas.w : canvas.w;
    for (let i = 0; i + 1 < pts.length; i++) {
      const glow = Math.abs(pts[i][0] - sweep) < 12 ? mix(t.accent, t.scan, 0.7) : t.accent;
      canvas.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], glow, 10);
    }
    if (this.app.anim) canvas.line(sweep, 0, sweep, canvas.h - 1, mix(t.panel, t.scan, 0.5), 5);
    if (!sigs.length) canvas.label(Math.floor(canvas.cols / 2) - 10, Math.floor(canvas.rows / 2), 'waiting for instruments…', t.dim, { force: true });
    canvas.blit(ctx, plot);
    s.text(plot.x, plot.y + plot.h, truncate('−24 h', 6), { fg: t.dim, bg: t.panel });
    s.text(plot.x + plot.w - 3, plot.y + plot.h, 'now', { fg: t.dim, bg: t.panel });
    // legend: each instrument with its level
    let ly = scopeR.y;
    const lx = plot.x + plot.w + 1;
    s.text(lx, ly++, 'INSTRUMENTS', { fg: t.accent, bg: t.panel, attr: ATTR.BOLD });
    for (const c of comp.contributors.slice(0, scopeR.h - 2)) {
      const lv = c.level === null ? 0 : c.level;
      const hot = c.warn !== undefined && c.current !== null && c.current >= c.warn;
      const val = c.current === null ? '—' : fmtSignal(c.current, c.unit);
      segments(ctx, lx, ly, [{ text: `${truncate(c.label, 10).padEnd(10)} `, fg: hot ? t.warn : t.text }, { text: bar5(lv), fg: hot ? t.warn : t.accent }, { text: ` ${val}`, fg: t.dim }], legendW, { bg: t.panel });
      ly += 1;
    }
    // --- heatmap: groups × hours
    const groupsOrder = Object.keys(GROUPS);
    const hm = heatmap(this.hub.events(), { now, bins: Math.max(12, Math.min(72, heatR.w - 16)), binMs: 3600000, by: 'group', order: groupsOrder });
    heading(ctx, heatR.x, heatR.y, `energy spikes · last ${hm.bins} h`, heatR.w);
    let hy = heatR.y + 1;
    const labelW = 17;
    const rowsShown = hm.rows.slice(0, heatR.h - 2);
    for (const row of rowsShown) {
      const g = groupOf(row.key);
      s.text(heatR.x, hy, `${g.glyph} ${truncate(g.label, labelW - 3)}`.padEnd(labelW), { fg: t.dim, bg: t.panel });
      const max = Math.max(1, row.max);
      for (let i = 0; i < hm.bins; i++) {
        const v = row.cells[i] / max;
        const idx = v <= 0 ? 0 : Math.min(HEAT.length - 1, 1 + Math.floor(v * (HEAT.length - 2)));
        s.put(heatR.x + labelW + i, hy, HEAT[idx], { fg: mix(t.muted, t.accent2, v), bg: t.panel });
      }
      hy += 1;
    }
    if (!rowsShown.length) s.text(heatR.x, hy, 'no timed events yet', { fg: t.dim, bg: t.panel });
    // --- coincidences
    const ov = this.overlapsNow();
    heading(ctx, coR.x, coR.y, `coincidences · ${ov.length} within 6 h across sources`, coR.w);
    const listR = rect(coR.x, coR.y + 1, coR.w, Math.max(1, coR.h - 1));
    this.lists.stage.draw(
      ctx,
      listR,
      ov,
      (o, _i, { selected, width }) => [[
        { text: '⚡ ', fg: selected ? t.selText : t.warn },
        { text: truncate(o.a.title, Math.floor((width - 14) * 0.45)), fg: selected ? t.selText : t.text },
        { text: ` → ${fmtGap(o.gapMs)} → `, fg: selected ? t.selText : t.accent },
        { text: truncate(o.b.title, Math.floor((width - 14) * 0.45)), fg: selected ? t.selText : t.text },
      ]],
      this.listOpts('stage', { rowHeight: 1, empty: 'no cross-source overlaps in the last 72 h (quiet universe)' }),
    );
  }

  renderPrompter(ctx, r) {
    const { s, t, now } = ctx;
    const p = this.prompter;
    const w = Math.min(r.w - 4, 72);
    const h = 5;
    const x = r.x + Math.floor((r.w - w) / 2);
    const y = r.y + Math.floor((r.h - h) / 2);
    const box = rect(x, y, w, h);
    s.fill(box, ' ', { bg: t.sel, fg: t.text, attr: 0 });
    s.box(box, { fg: t.borderFocus, bg: t.sel }, 'double');
    s.text(x + 2, y, p.kind === 'topic' ? ' RESEARCH A TOPIC ' : ' ASK THE EXPLAINER ', { fg: t.title, bg: t.sel, attr: ATTR.BOLD });
    const shown = p.text.slice(-(w - 6));
    s.text(x + 2, y + 2, `› ${shown}`, { fg: t.text, bg: t.sel, attr: ATTR.BOLD });
    if (Math.floor(now / 400) % 2 === 0) s.put(x + 4 + strWidth(shown), y + 2, '█', { fg: t.accent, bg: t.sel });
    s.text(x + 2, y + 3, p.kind === 'topic' ? 'e.g. room-temperature superconductors · neutrino communication · quantum gravity tests' : 'e.g. why 41 degrees? · who paid for it? · what would falsify this?', { fg: t.dim, bg: t.sel }, w - 4);
  }
}

// --- small helpers ----------------------------------------------------------------------

function spinner(now) {
  return '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(now / 80) % 10];
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSignal(v, unit) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const txt = Math.abs(n) >= 1000 || (Math.abs(n) < 0.01 && n !== 0) ? n.toExponential(1) : Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(Math.abs(n) >= 10 ? 1 : 2);
  return `${txt}${unit ? ` ${unit}` : ''}`;
}

function bar5(level) {
  const k = Math.round(Math.max(0, Math.min(1, level)) * 5);
  return '█'.repeat(k) + '░'.repeat(5 - k);
}

// Headline "materialising": glitch glyphs resolve into the real text left to right.
export function materialize(text, progress, now) {
  const n = text.length;
  const resolved = Math.floor(n * Math.max(0, Math.min(1, progress * 1.15)));
  let out = text.slice(0, resolved);
  for (let i = resolved; i < n; i++) out += text[i] === ' ' ? ' ' : GLITCH[(i * 7 + Math.floor(now / 60)) % GLITCH.length];
  return out;
}
