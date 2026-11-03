// Storyboards: the explainer format the AI writes and the stage plays. A
// storyboard is a list of scenes; each scene has 3D elements, a camera move,
// typed narration, callouts that point at elements, and optional chart,
// equation and card panels. normalizeStoryboard() fills defaults and clamps
// values so a sloppy or partial JSON still plays; validateStoryboard() lists
// what is wrong for the repair prompt.

export const ELEMENT_TYPES = ['sphere', 'earth', 'galaxy', 'particles', 'orbit', 'beam', 'path', 'lattice', 'helix', 'torus', 'dish', 'strings', 'box', 'grid', 'ring', 'wave', 'cone', 'atom', 'arrow', 'pulse', 'text', 'star', 'cloud', 'detector'];
export const COLORS = ['accent', 'accent2', 'accent3', 'good', 'warn', 'bad', 'info', 'text', 'dim'];
export const CHART_TYPES = ['line', 'bar', 'spectrum', 'skymap', 'timeline', 'table'];
export const CARD_KINDS = ['person', 'fact', 'number', 'quote'];
export const SECRECY = ['public', 'buried', 'declassified', 'contested', 'suppressed'];

// Seconds of narration per character, and the floor and ceiling of a scene.
export const MS_PER_CHAR = 28;
export const SCENE_MIN_S = 10;
export const SCENE_MAX_S = 150;

// null counts as missing: JSON turns Infinity into null and a saved explainer must reload intact.
const n = (v, d, lo = -Infinity, hi = Infinity) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
const vec = (v, d = [0, 0, 0]) => (Array.isArray(v) && v.length >= 3 && v.every((x) => Number.isFinite(Number(x))) ? v.slice(0, 3).map(Number) : d);
const str = (v, d = '') => (typeof v === 'string' ? v : v === null || v === undefined ? d : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const objs = (v) => arr(v).filter((x) => x && typeof x === 'object');
export const VANISH_NEVER = 1e9; // seconds; finite so it survives JSON

export function sceneDuration(scene) {
  const chars = str(scene.narration).length + arr(scene.callouts).reduce((a, c) => a + str(c.text).length, 0) * 0.5;
  const s = (chars * MS_PER_CHAR) / 1000 + 4;
  return Math.max(SCENE_MIN_S, Math.min(SCENE_MAX_S, Number.isFinite(scene.duration) && scene.duration > 0 ? Math.max(scene.duration, s * 0.6) : s));
}

function normCamera(c = {}) {
  const from = c.from || c;
  const to = c.to || from;
  const cam = (x, d) => ({ yaw: n(x.yaw, d.yaw), pitch: n(x.pitch, d.pitch, -89, 89), dist: n(x.dist, d.dist, 0.5, 60), target: vec(x.target, d.target) });
  const f = cam(from, { yaw: 20, pitch: 15, dist: 7, target: [0, 0, 0] });
  return { from: f, to: cam(to, f), ease: ['linear', 'in', 'out', 'inout'].includes(c.ease) ? c.ease : 'inout', spin: n(c.spin, 0, -90, 90) };
}

function normElement(e, i) {
  const type = ELEMENT_TYPES.includes(e.type) ? e.type : 'sphere';
  const out = { ...e, id: str(e.id, `e${i + 1}`), type, at: vec(e.at), color: str(e.color, 'accent'), label: str(e.label), appear: n(e.appear, 0, 0), vanish: n(e.vanish, VANISH_NEVER, 0) };
  out.r = n(e.r, type === 'galaxy' ? 2 : type === 'earth' ? 1.2 : 0.8, 0.02, 40);
  out.spin = n(e.spin, type === 'galaxy' ? 8 : type === 'earth' ? 10 : 0, -720, 720);
  if (type === 'particles') {
    out.n = n(e.n, 120, 1, 2000);
    out.from = vec(e.from, out.at);
    out.dir = vec(e.dir, [1, 0, 0]);
    out.speed = n(e.speed, 1, 0, 50);
    out.spread = n(e.spread, 0.3, 0, 10);
    out.life = n(e.life, 3, 0.1, 60);
  }
  if (type === 'beam' || type === 'arrow') {
    out.from = vec(e.from, out.at);
    out.to = vec(e.to, [out.from[0] + 2, out.from[1], out.from[2]]);
    out.dash = n(e.dash, type === 'beam' ? 4 : 0, 0, 40);
    out.speed = n(e.speed, 12, -200, 200);
  }
  if (type === 'path') out.points = arr(e.points).map((p) => vec(p)).filter(Boolean);
  if (type === 'orbit') {
    out.bodies = n(e.bodies, 1, 0, 24);
    out.tilt = n(e.tilt, 20, -90, 90);
    out.speed = n(e.speed, 40, -720, 720);
  }
  if (type === 'lattice') {
    out.nx = n(e.nx, 4, 1, 12);
    out.ny = n(e.ny, 4, 1, 12);
    out.nz = n(e.nz, 4, 1, 12);
    out.spacing = n(e.spacing, 0.5, 0.05, 5);
  }
  if (type === 'helix') {
    out.turns = n(e.turns, 4, 0.5, 40);
    out.h = n(e.h, 2, 0.1, 20);
  }
  if (type === 'torus') out.r2 = n(e.r2, out.r * 0.35, 0.01, 20);
  if (type === 'strings' || type === 'detector') {
    out.n = n(e.n, 9, 1, 100);
    out.h = n(e.h, 2, 0.1, 20);
    out.spacing = n(e.spacing, 0.4, 0.05, 5);
    out.doms = n(e.doms, 8, 1, 60);
  }
  if (type === 'box') {
    out.w = n(e.w, 1, 0.05, 40);
    out.h = n(e.h, 1, 0.05, 40);
    out.d = n(e.d, 1, 0.05, 40);
  }
  if (type === 'grid') out.step = n(e.step, 0.5, 0.05, 10);
  if (type === 'ring' || type === 'pulse') {
    out.tilt = n(e.tilt, 0, -90, 90);
    out.r1 = n(e.r1, out.r * 3, 0.02, 60);
    out.period = n(e.period, 2.5, 0.2, 60);
  }
  if (type === 'wave') {
    out.amp = n(e.amp, 0.2, 0, 5);
    out.freq = n(e.freq, 2, 0.1, 30);
    out.speed = n(e.speed, 1, -20, 20);
  }
  if (type === 'cone' || type === 'dish') out.h = n(e.h, out.r, 0.05, 40);
  if (type === 'atom') out.shells = n(e.shells, 2, 1, 6);
  if (type === 'text') out.text = str(e.text, out.label);
  if (type === 'cloud') out.n = n(e.n, 300, 10, 4000);
  return out;
}

function normChart(c) {
  if (!c || typeof c !== 'object') return null;
  const type = CHART_TYPES.includes(c.type) ? c.type : 'line';
  const series = objs(c.series).map((s) => ({ label: str(s.label), color: str(s.color, 'accent'), values: arr(s.values).map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, Number(p)])).filter((p) => Number.isFinite(p[1])) })).filter((s) => s.values.length);
  const rows = arr(c.rows).filter(Array.isArray).map((r) => r.map((x) => str(x)));
  if (!series.length && !rows.length && type !== 'timeline') return null;
  return { type, title: str(c.title), xLabel: str(c.xLabel), yLabel: str(c.yLabel), series, rows, columns: arr(c.columns).map((x) => str(x)), events: objs(c.events).map((e) => ({ x: Number(e.x), label: str(e.label) })).filter((e) => Number.isFinite(e.x)), log: Boolean(c.log) };
}

export function normalizeScene(s, i) {
  const scene = {
    id: str(s.id, `s${i + 1}`),
    title: str(s.title, `Scene ${i + 1}`),
    kicker: str(s.kicker),
    narration: str(s.narration).trim(),
    camera: normCamera(s.camera),
    elements: arr(s.elements).filter((e) => e && typeof e === 'object').map(normElement),
    callouts: objs(s.callouts).filter((c) => str(c.text).trim()).map((c) => ({ t: n(c.t, 0, 0), text: str(c.text).trim(), target: str(c.target, '') || null, side: ['left', 'right', 'top', 'bottom'].includes(c.side) ? c.side : 'right', hold: n(c.hold, 0, 0) })),
    chart: normChart(s.chart),
    equation: s.equation && str(s.equation.expr || s.equation).trim() ? { expr: str(s.equation.expr || s.equation).trim(), meaning: str(s.equation.meaning) } : null,
    card: s.card && typeof s.card === 'object' ? { kind: CARD_KINDS.includes(s.card.kind) ? s.card.kind : 'fact', title: str(s.card.title), lines: arr(s.card.lines).map((x) => str(x)).filter(Boolean), value: str(s.card.value), unit: str(s.card.unit), who: str(s.card.who), years: str(s.card.years) } : null,
    location: s.location && Number.isFinite(Number(s.location.lat)) && Number.isFinite(Number(s.location.lon)) ? { name: str(s.location.name), lat: Number(s.location.lat), lon: Number(s.location.lon) } : null,
    sources: arr(s.sources).filter((x) => x && (typeof x === 'string' || typeof x === 'object')).map((x) => (typeof x === 'string' ? { title: x, url: x } : { title: str(x.title, x.url), url: str(x.url) })).filter((x) => /^https?:/i.test(x.url)),
  };
  scene.duration = sceneDuration({ ...scene, duration: Number(s.duration) });
  scene.callouts.sort((a, b) => a.t - b.t);
  return scene;
}

export function normalizeStoryboard(raw, finding = {}) {
  const sb = raw && typeof raw === 'object' ? raw : {};
  const meta = sb.meta && typeof sb.meta === 'object' ? sb.meta : {};
  const scenes = arr(sb.scenes).filter((s) => s && typeof s === 'object').map(normalizeScene);
  return {
    id: str(sb.id, finding.id || 'storyboard'),
    title: str(sb.title, finding.title || 'Untitled'),
    subtitle: str(sb.subtitle, finding.field || ''),
    field: str(sb.field, finding.field || ''),
    summary: str(sb.summary, finding.summary || ''),
    meta: {
      people: objs(meta.people).map((p) => ({ name: str(p.name), years: str(p.years), role: str(p.role), note: str(p.note) })).filter((p) => p.name),
      timeline: objs(meta.timeline).map((t) => ({ year: str(t.year), text: str(t.text) })).filter((t) => t.text),
      locations: objs(meta.locations).map((l) => ({ name: str(l.name), lat: Number(l.lat), lon: Number(l.lon), note: str(l.note) })).filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon)),
      sources: arr(meta.sources).filter((x) => x && (typeof x === 'string' || typeof x === 'object')).map((x) => (typeof x === 'string' ? { title: x, url: x } : { title: str(x.title, x.url), url: str(x.url) })).filter((x) => /^https?:/i.test(x.url)),
      math: objs(meta.math).map((m) => ({ name: str(m.name), expr: str(m.expr), meaning: str(m.meaning) })).filter((m) => m.expr),
      uses: arr(meta.uses).map((u) => str(u)).filter(Boolean),
      secrecy: { level: SECRECY.includes(meta.secrecy?.level) ? meta.secrecy.level : finding.secrecy?.level || 'public', notes: str(meta.secrecy?.notes, finding.secrecy?.notes || '') },
      coveredUp: str(meta.coveredUp),
      glossary: objs(meta.glossary).map((g) => ({ term: str(g.term), meaning: str(g.meaning) })).filter((g) => g.term),
    },
    scenes,
    generatedAt: Number(sb.generatedAt) || Date.now(),
    model: str(sb.model),
    totalS: scenes.reduce((a, s) => a + s.duration, 0),
  };
}

// Problems worth sending back to the writer. Empty array means playable.
export function validateStoryboard(sb) {
  const problems = [];
  if (!sb || !Array.isArray(sb.scenes)) return ['no scenes array'];
  if (sb.scenes.length < 6) problems.push(`only ${sb.scenes.length} scenes; an explainer needs at least 6`);
  sb.scenes.forEach((s, i) => {
    if (!s.narration || s.narration.length < 120) problems.push(`scene ${i + 1} (${s.title}) narration is too short`);
    if (!s.elements.length) problems.push(`scene ${i + 1} (${s.title}) has no elements`);
    if (!s.callouts.length) problems.push(`scene ${i + 1} (${s.title}) has no callouts`);
    for (const c of s.callouts) if (c.target && !s.elements.some((e) => e.id === c.target)) problems.push(`scene ${i + 1} callout targets unknown element "${c.target}"`);
  });
  if (!sb.meta.people.length) problems.push('meta.people is empty: who discovered this and who helped?');
  if (!sb.meta.timeline.length) problems.push('meta.timeline is empty');
  if (!sb.meta.sources.length) problems.push('meta.sources is empty');
  if (!sb.meta.math.length) problems.push('meta.math is empty: at least one equation with its meaning');
  return problems;
}

// Pull the first JSON object out of model text (fenced or bare).
export function extractJson(text) {
  const s = String(text || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try a lenient pass: strip trailing commas
      try {
        return JSON.parse(c.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        // next candidate
      }
    }
  }
  return null;
}

// Findings streamed by the research run: <finding>{...}</finding> blocks.
export function extractFindings(text, { addedAt = Date.now() } = {}) {
  const out = [];
  const re = /<finding>([\s\S]*?)<\/finding>/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const json = extractJson(m[1]);
    const f = normalizeFinding(json, addedAt);
    if (f) out.push(f);
  }
  return out;
}

export function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function normalizeFinding(f, addedAt = Date.now()) {
  if (!f || typeof f !== 'object' || !str(f.title).trim()) return null;
  const title = str(f.title).trim().slice(0, 160);
  return {
    id: str(f.id).trim() ? slug(f.id) : `${slug(title)}-${addedAt.toString(36).slice(-4)}`,
    title,
    hook: str(f.hook).trim(),
    field: str(f.field).trim(),
    date: str(f.date).trim(),
    summary: str(f.summary).trim(),
    why: str(f.why_it_matters || f.why).trim(),
    sources: arr(f.sources).filter((x) => x && (typeof x === 'string' || typeof x === 'object')).map((x) => (typeof x === 'string' ? { title: x, url: x } : { title: str(x.title, x.url), url: str(x.url) })).filter((x) => /^https?:/i.test(x.url)).slice(0, 12),
    people: arr(f.people).filter((p) => p && (typeof p === 'string' || typeof p === 'object')).map((p) => (typeof p === 'string' ? { name: p, role: '' } : { name: str(p.name), role: str(p.role) })).filter((p) => p.name).slice(0, 12),
    locations: objs(f.locations).map((l) => ({ name: str(l.name), lat: Number(l.lat), lon: Number(l.lon) })).filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon)).slice(0, 8),
    secrecy: { level: SECRECY.includes(f.secrecy?.level) ? f.secrecy.level : 'public', notes: str(f.secrecy?.notes).trim() },
    confidence: n(f.confidence, 0.6, 0, 1),
    tags: arr(f.tags).map((t) => str(t).toLowerCase()).filter(Boolean).slice(0, 8),
    topic: str(f.topic).trim(),
    addedAt,
    status: 'new',
  };
}
