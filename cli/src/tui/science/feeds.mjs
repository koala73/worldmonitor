// Feed plumbing for the Phenomena view: a lenient RSS / Atom / RDF parser,
// a capped text fetch, and FeedHub, which polls every registered science
// source on its own cadence while the view wants it and merges the results
// into one timeline of events and one set of signal series. Zero dependencies.
import { decodeEntities } from '../term/ansi.mjs';

const MAX_BODY = 512 * 1024; // the biggest lab feeds run to ~1 MB; the newest items come first

export function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, ' ')
      .replace(/<[^<>]*>/g, ''), // no backtracking on unclosed tags
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// Inner text of the first <name> element in a block (namespaced names allowed).
export function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = re.exec(block);
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
}

export function attr(block, name, attrName) {
  const re = new RegExp(`<${name}\\b[^>]*\\b${attrName}=["']([^"']*)["'][^>]*/?>`, 'i');
  const m = re.exec(block);
  return m ? decodeEntities(m[1]) : '';
}

export function parseDate(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).trim());
  return Number.isFinite(t) ? t : 0;
}

// Parse RSS 2.0, RDF (RSS 1.0) and Atom into { title, items: [{ title, link, summary, at, author }] }.
// Truncated documents still yield every complete item.
export function parseFeed(text) {
  const src = String(text || '');
  const isAtom = /<feed[\s>]/i.test(src) && /<entry[\s>]/i.test(src);
  const blockRe = isAtom ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  const first = src.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = src.slice(0, first < 0 ? 2000 : first);
  const items = [];
  let m;
  while ((m = blockRe.exec(src))) {
    const b = m[1];
    const title = stripTags(tag(b, 'title'));
    let link = '';
    if (isAtom) {
      link = attr(b, 'link\\b[^>]*\\brel=["\']alternate["\']', 'href') || attr(b, 'link', 'href');
      if (!link) link = stripTags(tag(b, 'id'));
    } else {
      link = stripTags(tag(b, 'link')) || attr(b, 'link', 'href') || attr(b, 'item', 'rdf:about') || stripTags(tag(b, 'guid'));
      if (!link) link = attr(b, 'enclosure', 'url');
    }
    const summary = stripTags(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || tag(b, 'content:encoded') || tag(b, 'media:description'));
    const at = parseDate(tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'prism:publicationDate') || tag(b, 'date'));
    const author = stripTags(tag(b, 'dc:creator') || tag(tag(b, 'author'), 'name') || tag(b, 'author'));
    if (!title && !link) continue;
    items.push({ title, link: /^https?:/i.test(link) ? link : '', summary, at, author });
  }
  return { title: stripTags(tag(head, 'title')), items };
}

// GET a body as text, capped at `maxBytes`, with a descriptive User-Agent.
export async function fetchBody(url, { fetch = (...a) => globalThis.fetch(...a), userAgent = 'worldmonitor-tui', timeoutMs = 20000, maxBytes = MAX_BODY, accept = '*/*', signal = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const onOuter = () => controller.abort(new Error('aborted'));
  if (signal) signal.addEventListener('abort', onOuter, { once: true });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: accept }, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total >= maxBytes) {
          reader.cancel().catch(() => {});
          break;
        }
      }
      return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes).toString('utf8');
    }
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuter);
  }
}

// Instrument readings share a landing page per feed, so their identity is title + time, not URL.
export const INSTRUMENT_KINDS = new Set(['alert', 'event', 'measurement']);

export function eventId(sourceId, key) {
  let h = 2166136261;
  const s = `${sourceId}|${key}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${sourceId}:${(h >>> 0).toString(36)}`;
}

// Polls sources while wanted; keeps the latest events and signals per source.
export class FeedHub {
  constructor({ sources, fetch = (...a) => globalThis.fetch(...a), userAgent = 'worldmonitor-tui', now = () => Date.now(), onChange = () => {}, concurrency = 3, tickMs = 5000, startDelayMs = 300 } = {}) {
    this.sources = sources;
    this.fetch = fetch;
    this.userAgent = userAgent;
    this.now = now;
    this.onChange = onChange;
    this.concurrency = concurrency;
    this.tickMs = tickMs;
    this.startDelayMs = startDelayMs; // a view that is only passed through never starts a fetch
    this.startTimer = null;
    this.state = new Map(); // id -> { loadedAt, error, loading, events, signal, attempts, retryAt }
    for (const s of sources) this.state.set(s.id, { loadedAt: 0, error: null, loading: false, events: [], signal: null, attempts: 0, retryAt: 0 });
    this.timer = null;
    this.wanted = false;
    this.inflight = 0;
    this.closed = false;
    this.cache = { events: null, at: 0 };
  }

  want(on) {
    this.wanted = on;
    if (on && !this.timer && !this.startTimer) {
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        if (!this.wanted || this.closed) return;
        this.timer = setInterval(() => this.tick(), this.tickMs);
        if (this.timer.unref) this.timer.unref();
        this.tick();
      }, this.startDelayMs);
      if (this.startTimer.unref) this.startTimer.unref();
    } else if (!on) {
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }

  close() {
    this.closed = true;
    this.want(false);
  }

  due(s, st, now) {
    if (st.loading) return false;
    if (st.retryAt) return now >= st.retryAt;
    return !st.loadedAt || now - st.loadedAt >= s.every;
  }

  tick() {
    if (this.closed) return;
    const now = this.now();
    // Oldest first so no source starves.
    const pending = this.sources.filter((s) => this.due(s, this.state.get(s.id), now)).sort((a, b) => this.state.get(a.id).loadedAt - this.state.get(b.id).loadedAt);
    for (const s of pending) {
      if (this.inflight >= this.concurrency) break;
      this.refresh(s.id).catch(() => {});
    }
  }

  async refresh(id, { force = false } = {}) {
    const s = this.sources.find((x) => x.id === id);
    const st = this.state.get(id);
    if (!s || !st || st.loading) return false;
    if (!force && !this.due(s, st, this.now())) return false;
    st.loading = true;
    this.inflight += 1;
    try {
      const url = s.urlFor ? s.urlFor(this.now()) : s.url;
      const body = await fetchBody(url, { fetch: this.fetch, userAgent: this.userAgent, accept: s.accept || (s.kind === 'json' ? 'application/json' : '*/*'), maxBytes: s.maxBytes || MAX_BODY, timeoutMs: s.timeoutMs || 20000 });
      const parsed = s.kind === 'json' ? JSON.parse(body) : s.kind === 'feed' ? parseFeed(body) : body;
      const out = s.parse(parsed, { source: s, now: this.now() }) || {};
      const events = (out.events || []).filter((e) => e && e.title).map((e) => ({ ...e, tags: Array.isArray(e.tags) ? e.tags : [], url: e.url || '', source: s.id, sourceLabel: s.label, group: s.group, id: e.id || eventId(s.id, INSTRUMENT_KINDS.has(e.kind) ? `${e.title}|${e.at || ''}` : e.url || e.title) }));
      st.events = events;
      if (out.signal) st.signal = { ...out.signal, source: s.id };
      st.loadedAt = this.now();
      st.error = null;
      st.attempts = 0;
      st.retryAt = 0;
      this.cache.events = null;
      return true;
    } catch (err) {
      st.error = err && err.message ? err.message : String(err);
      st.attempts += 1;
      st.retryAt = this.now() + Math.min(30 * 60000, 60000 * 2 ** Math.min(5, st.attempts));
      return false;
    } finally {
      st.loading = false;
      this.inflight -= 1;
      if (!this.closed) this.onChange(id);
    }
  }

  // Every event from every source, newest first, deduplicated by link / title.
  events() {
    if (this.cache.events) return this.cache.events;
    const seen = new Set();
    const all = [];
    for (const st of this.state.values()) {
      for (const e of st.events) {
        const key = INSTRUMENT_KINDS.has(e.kind) ? e.id : (e.url || e.title).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(e);
      }
    }
    all.sort((a, b) => (b.at || 0) - (a.at || 0));
    this.cache.events = all;
    return all;
  }

  signals() {
    const out = [];
    for (const st of this.state.values()) if (st.signal) out.push(st.signal);
    return out;
  }

  status() {
    const rows = this.sources.map((s) => {
      const st = this.state.get(s.id);
      return { id: s.id, label: s.label, group: s.group, url: s.url, home: s.home || s.url, loadedAt: st.loadedAt, error: st.error, loading: st.loading, count: st.events.length, every: s.every };
    });
    const loaded = rows.filter((r) => r.loadedAt).length;
    const errors = rows.filter((r) => r.error).length;
    const loading = rows.filter((r) => r.loading).length;
    return { rows, loaded, errors, loading, total: rows.length };
  }
}
