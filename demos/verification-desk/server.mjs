#!/usr/bin/env node
// The Verification Desk: stage server.
//   npm start                 live WorldMonitor data (needs .env)
//   npm run offline           committed real snapshots only, no keys, no network
// Open http://localhost:4317 on the stage laptop, press F for fullscreen.

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDesk, DATA_DIR, loadEnv, ROOT } from './lib/config.mjs';
import { gradeHeadline } from './lib/grade.mjs';
import { templateBoard } from './lib/anchor.mjs';
import { buildBoard } from './lib/board.mjs';
import { findRevealCandidates } from './lib/reveal.mjs';
import { coverage, credibilityBand, sourceCredibility } from './lib/wm.mjs';
import * as liveavatar from './lib/liveavatar.mjs';

loadEnv();
const PORT = Number(process.env.PORT || 4317);
const desk = buildDesk();
const PUBLIC = path.join(ROOT, 'public');
const CACHE_DIR = path.join(DATA_DIR, 'cache');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Last-good cache on disk: if the venue network drops mid-show, the recap and
// reveal still play from the last successful run.
async function cached(name, produce) {
  const file = path.join(CACHE_DIR, `${name}.json`);
  try {
    const value = await produce();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ savedAt: new Date().toISOString(), value }, null, 2));
    return { ...value, fromCache: false };
  } catch (error) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      return { ...saved.value, fromCache: true, cacheSavedAt: saved.savedAt, liveError: error.message };
    } catch {
      throw error;
    }
  }
}

async function recap() {
  return cached('recap', async () => {
    const week = desk.source.weekClusters ? await desk.source.weekClusters() : [];
    let stories;
    let scope;
    // Every story is graded by WorldMonitor: coverage state, publishers, credibility.
    const grade = (title, labels, reported, credibilityScore) => {
      const { verdict, roster } = coverage(labels, reported);
      const lead = roster[0];
      const score = Number.isFinite(credibilityScore) ? credibilityScore : lead ? sourceCredibility(lead.labels[0] ?? lead.name, verdict.publishers ?? 1) : null;
      return { title, state: verdict.state, publishers: verdict.publishers, credibility: score == null ? null : Math.round(score), band: score == null ? null : credibilityBand(score) };
    };
    if (week.length >= 5) {
      stories = week
        .map((c) => grade(c.title, c.sources ?? [], c.corroboration?.publishers ?? null, c.credibilityScore))
        .filter((s) => s.publishers)
        .sort((a, b) => b.publishers - a.publishers)
        .slice(0, 6);
      scope = 'the last seven days';
    } else {
      const brief = await desk.source.brief();
      stories = brief.headlines.slice(0, 6).map((title, i) => {
        const t = brief.topStories?.[i] ?? {};
        return grade(title, t.sources ?? t.publishers?.flatMap((p) => p.labels ?? [p.name]) ?? [], t.corroboration?.publishers ?? t.uniqueSourceCount ?? null, t.credibilityScore);
      });
      scope = 'the world right now';
    }
    const script = await desk.anchor.narrateRecap(stories, scope);
    return { scope, stories, script };
  });
}

// Today's board, rebuilt at most once per DESK_BOARD_REFRESH_MIN (WorldMonitor
// allowance: two MCP calls per rebuild, both cached by LiveSource).
const BOARD_REFRESH_MS = Number(process.env.DESK_BOARD_REFRESH_MIN || 15) * 60_000;
let boardMemo = null;
async function board({ force = false } = {}) {
  if (!force && boardMemo && Date.now() - boardMemo.at < BOARD_REFRESH_MS) return boardMemo.value;
  const value = await cached('board', async () => {
    const { clusters, from, asOf } = await desk.source.boardClusters({ force });
    const b = buildBoard(clusters, { asOf: asOf ?? new Date().toISOString() });
    return { ...b, from, refreshMinutes: BOARD_REFRESH_MS / 60_000, script: await desk.anchor.narrateBoard({ ...b, from }) };
  });
  // A board replayed from disk was narrated as live when it was saved; the
  // anchor must not say "right now" about it.
  if (value.fromCache) value.script = templateBoard(value);
  boardMemo = { at: Date.now(), value };
  return value;
}

async function reveal() {
  const pinnedPath = path.join(DATA_DIR, 'reveal.json');
  // data/reveal.json (pinned locally) wins over the committed snapshots/reveal.json.
  for (const file of [pinnedPath, path.join(ROOT, 'snapshots', 'reveal.json')]) {
    try {
      const pinned = JSON.parse(await readFile(file, 'utf8'));
      return { ...pinned, pinned: true };
    } catch {
      // not pinned here
    }
  }
  return cached('reveal', async () => {
    const [top] = await findRevealCandidates(desk.source, { limit: 1 });
    if (!top) throw new Error('No single-source candidate in the current data. Run scripts/find-reveal.mjs after a few snapshots.');
    const script = await desk.anchor.narrateReveal(top);
    return { candidate: top, script, pinned: false };
  });
}

async function tts(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voice) return null;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg', 'User-Agent': 'WorldMonitor-VerificationDesk/1.0' },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5', voice_settings: { stability: 0.45, similarity_boost: 0.8 } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer(async (req, res) => {
  try {
    // Inside the try: a malformed Host header must answer 500, not exit the process.
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/config') {
      return sendJson(res, 200, {
        offline: desk.offline,
        sourceKind: desk.source.kind,
        anchor: desk.anchor.enabled ? desk.anchor.model : null,
        tts: process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID ? 'elevenlabs' : 'browser',
        // The documented embed URL on the www host: the apex redirects, and a
        // layer-less /embed is not the dashboard map. DESK_BACKDROP_URL= (empty) turns it off.
        // Offline never loads it; DESK_BACKDROP_URL=off turns it off on stage (a blank .env line can't: blanks are placeholders).
        backdropUrl: desk.noNetwork || /^(off|none)$/i.test(process.env.DESK_BACKDROP_URL ?? '') ? '' : (process.env.DESK_BACKDROP_URL || 'https://www.worldmonitor.app/embed?layers=conflicts,earthquakes,weather&center=20,0&zoom=1&theme=dark&variant=full'),
        avatar: liveavatar.configured(),
        boardRefreshMin: BOARD_REFRESH_MS / 60_000,
        stepDelayMs: Number(process.env.DESK_STEP_DELAY_MS || 1400),
      });
    }

    if (url.pathname === '/api/grade') {
      const headline = (url.searchParams.get('headline') || '').trim().slice(0, 300);
      if (!headline) return sendJson(res, 400, { error: 'headline required' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const log = [];
      // When the deck replaces this check, stop at the next step instead of
      // spending the rest of its WorldMonitor and Claude calls on a closed socket.
      let gone = false;
      res.on('close', () => { gone = true; });
      try {
        for await (const ev of gradeHeadline(headline, desk)) {
          if (gone) break;
          log.push(ev);
          res.write(`event: ${ev.step}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        }
      } catch (error) {
        if (!gone) res.write(`event: failure\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      }
      res.end();
      if (gone) return;
      // Keep a record of every live grade for the post-panel write-up.
      mkdir(path.join(DATA_DIR, 'grades'), { recursive: true })
        .then(() => writeFile(path.join(DATA_DIR, 'grades', `${Date.now()}.json`), JSON.stringify(log, null, 2)))
        .catch(() => {});
      return;
    }

    if (url.pathname === '/api/recap') return sendJson(res, 200, await recap());
    if (url.pathname === '/api/board') return sendJson(res, 200, await board({ force: url.searchParams.get('refresh') === '1' }));
    if (url.pathname === '/api/avatar/token' && req.method === 'POST') {
      try {
        return sendJson(res, 200, await liveavatar.createToken());
      } catch (error) {
        return sendJson(res, 502, { error: error.message });
      }
    }
    if (url.pathname === '/api/reveal') return sendJson(res, 200, await reveal());

    if (url.pathname === '/api/tts' && req.method === 'POST') {
      const { text } = await readBody(req);
      const audio = text ? await tts(String(text).slice(0, 2500)) : null;
      if (!audio) return sendJson(res, 204, {});
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      return res.end(audio);
    }

    // The stage deck is the show; the standalone desk stays at /desk.
    const rel = url.pathname === '/'
      ? (existsSync(path.join(PUBLIC, 'deck.html')) ? 'deck.html' : 'index.html')
      : url.pathname === '/desk' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'forbidden' });
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    return res.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
    return sendJson(res, 500, { error: error.message });
  }
});

desk.source.live?.warm?.();

// Localhost only by default: the paid routes (TTS, avatar tokens, grading) use
// the presenter's keys and allowance. DESK_HOST=0.0.0.0 opens it to the network.
const HOST = process.env.DESK_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`Verification Desk on http://localhost:${PORT}`);
  console.log(`  source: ${desk.source.kind}${desk.offline ? ' (committed snapshots, offline)' : ''}`);
  console.log(`  anchor: ${desk.anchor.enabled ? desk.anchor.model : 'template voice (no ANTHROPIC_API_KEY)'}`);
  console.log(`  voice:  ${process.env.ELEVENLABS_API_KEY ? 'ElevenLabs' : 'browser speech synthesis'}`);
  console.log(`  avatar: ${liveavatar.configured() ? 'HeyGen LiveAvatar (press A to switch with the globe)' : 'globe only (no LiveAvatar key)'}`);
});
