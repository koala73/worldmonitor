#!/usr/bin/env node
// Minimal screenshot sink: the browser POSTs a data:image/... URL (grabbed from
// the real-GPU Cesium canvas) and this writes it to qa-shots/height-datum/<name>.
// Keeps large image payloads OUT of the agent's context — browser → sink → disk.
// Usage: node scripts/shot-sink.mjs   (listens on :4399)
import http from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'qa-shots', 'height-datum');
mkdirSync(OUT, { recursive: true });
const PORT = 4399;

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/save') {
    const name = (url.searchParams.get('name') || 'shot').replace(/[^a-zA-Z0-9._-]/g, '_');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(body.trim());
        if (!m) { res.writeHead(400); res.end('bad dataurl'); return; }
        const ext = m[1] === 'jpeg' ? 'jpg' : 'png';
        const file = path.join(OUT, `${name}.${ext}`);
        writeFileSync(file, Buffer.from(m[2], 'base64'));
        res.writeHead(200); res.end(file);
        console.log(`saved ${file} (${Math.round(m[2].length / 1024)} KB b64)`);
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    return;
  }
  res.writeHead(404); res.end('nope');
}).listen(PORT, () => console.log(`shot-sink on http://localhost:${PORT} → ${OUT}`));
