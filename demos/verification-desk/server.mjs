#!/usr/bin/env node
// The Verification Desk: stage server.
//   npm start                 live WorldMonitor data (needs .env)
//   npm run rehearse          fictional rehearsal data, no keys needed
// Open http://localhost:4317 on the stage laptop, press F for fullscreen.

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDesk, DATA_DIR, loadEnv, ROOT } from './lib/config.mjs';
import { gradeHeadline } from './lib/grade.mjs';
import { findRevealCandidates } from './lib/reveal.mjs';

loadEnv();
const PORT = Number(process.env.PORT || 4317);
const desk = buildDesk();
const PUBLIC = path.join(ROOT, 'public');
const CACHE_DIR = path.join(DATA_DIR, desk.rehearsal ? 'cache-rehearsal' : 'cache');

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
    if (week.length >= 5) {
      // Biggest stories of the archived week by independent publisher families.
      stories = week
        .filter((c) => c.corroboration?.publishers)
        .sort((a, b) => b.corroboration.publishers - a.corroboration.publishers)
        .slice(0, 6)
        .map((c) => ({ title: c.title, publishers: c.corroboration.publishers, state: c.corroboration.state, firstSeen: c.firstSeen }));
      scope = desk.rehearsal ? 'the rehearsal week' : 'the last seven days';
    } else {
      const brief = await desk.source.brief();
      stories = brief.headlines.slice(0, 6).map((title, i) => ({
        title,
        publishers: brief.topStories?.[i]?.corroboration?.publishers ?? brief.topStories?.[i]?.uniqueSourceCount ?? null,
        state: brief.topStories?.[i]?.corroboration?.state ?? 'unknown',
      }));
      scope = 'the world right now';
    }
    const script = await desk.anchor.narrateRecap(stories, scope);
    return { scope, stories, script };
  });
}

async function reveal() {
  const pinnedPath = path.join(DATA_DIR, desk.rehearsal ? 'reveal-rehearsal.json' : 'reveal.json');
  // data/reveal.json (pinned locally) wins over the committed snapshots/reveal.json.
  for (const file of desk.rehearsal ? [pinnedPath] : [pinnedPath, path.join(ROOT, 'snapshots', 'reveal.json')]) {
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/config') {
      return sendJson(res, 200, {
        rehearsal: desk.rehearsal,
        sourceKind: desk.source.kind,
        anchor: desk.anchor.enabled ? desk.anchor.model : null,
        tts: process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID ? 'elevenlabs' : 'browser',
        backdropUrl: process.env.DESK_BACKDROP_URL ?? 'https://worldmonitor.app/embed?theme=dark',
        avatarEmbedUrl: process.env.DESK_AVATAR_EMBED_URL || null,
        stepDelayMs: Number(process.env.DESK_STEP_DELAY_MS || 1400),
      });
    }

    if (url.pathname === '/api/grade') {
      const headline = (url.searchParams.get('headline') || '').trim().slice(0, 300);
      if (!headline) return sendJson(res, 400, { error: 'headline required' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const log = [];
      try {
        for await (const ev of gradeHeadline(headline, desk)) {
          log.push(ev);
          res.write(`event: ${ev.step}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        }
      } catch (error) {
        res.write(`event: failure\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      }
      res.end();
      // Keep a record of every live grade for the post-panel write-up.
      mkdir(path.join(DATA_DIR, 'grades'), { recursive: true })
        .then(() => writeFile(path.join(DATA_DIR, 'grades', `${Date.now()}.json`), JSON.stringify(log, null, 2)))
        .catch(() => {});
      return;
    }

    if (url.pathname === '/api/recap') return sendJson(res, 200, await recap());
    if (url.pathname === '/api/reveal') return sendJson(res, 200, await reveal());

    if (url.pathname === '/api/tts' && req.method === 'POST') {
      const { text } = await readBody(req);
      const audio = text ? await tts(String(text).slice(0, 2500)) : null;
      if (!audio) return sendJson(res, 204, {});
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      return res.end(audio);
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
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

server.listen(PORT, () => {
  console.log(`Verification Desk on http://localhost:${PORT}`);
  console.log(`  source: ${desk.source.kind}${desk.rehearsal ? ' (FICTIONAL rehearsal data)' : ''}`);
  console.log(`  anchor: ${desk.anchor.enabled ? desk.anchor.model : 'template voice (no ANTHROPIC_API_KEY)'}`);
  console.log(`  voice:  ${process.env.ELEVENLABS_API_KEY ? 'ElevenLabs' : 'browser speech synthesis'}`);
});
