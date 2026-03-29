#!/usr/bin/env node
// Downloads CC0 metal_plate PBR textures from Poly Haven into public/vault-tex/.
// Idempotent — skips individual files that already exist.
// Run via: npm run vault-tex:download
// Also runs automatically as predesktop:build:full.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '../public/vault-tex');
mkdirSync(OUT_DIR, { recursive: true });

const BASE = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/metal_plate';
const FILES = [
  'metal_plate_diff_1k.jpg',
  'metal_plate_nor_gl_1k.jpg',
  'metal_plate_rough_1k.jpg',
  'metal_plate_ao_1k.jpg',
];

let downloaded = 0;
let skipped = 0;

for (const file of FILES) {
  const dest = join(OUT_DIR, file);
  if (existsSync(dest)) {
    console.log(`[vault-tex] skip  ${file} (already present)`);
    skipped++;
    continue;
  }
  const url = `${BASE}/${file}`;
  console.log(`[vault-tex] fetch ${url}`);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'WorldMonitor/2.7 (github.com/bradleybond512/worldmonitor-macos)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    console.log(`[vault-tex] saved ${dest} (${(buf.length / 1024).toFixed(0)} KB)`);
    downloaded++;
  } catch (error) {
    console.warn(`[vault-tex] WARN: could not download ${file}: ${error.message}`);
    console.warn('[vault-tex] Build will continue — procedural textures will be used as fallback.');
  }
}

console.log(`[vault-tex] done — ${downloaded} downloaded, ${skipped} already present.`);
