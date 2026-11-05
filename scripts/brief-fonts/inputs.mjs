// What the brief font files were cut for, read from the renderer's CSS. run.mjs records it in
// scripts/brief-fonts/manifest.json; tests/brief-fonts-fresh.test.mjs compares it with the
// current renderer to say when `npm run brief-fonts:subset` needs rerunning.
import fs from 'node:fs';
import path from 'node:path';

export const BRIEF_RENDERER = 'server/_shared/brief-render.js';
const FONT_PROPS = /(?<![\w-])(font-weight|font-style|font-variant(?:-[a-z]+)?|font-feature-settings|font-variation-settings|font-synthesis(?:-[a-z]+)?|font-family|font-optical-sizing|font|text-transform|hyphens)\s*:\s*([^;{}\n]+)/g;
const LANG_ATTR = /\blang=["']([^"']+)["']/g;

// The rule's selector, so moving a declaration to another rule also asks for a rerun.
function selector(text, index) {
  const before = text.slice(0, index);
  const open = before.lastIndexOf('{');
  if (open < 0 || open < before.lastIndexOf('}')) return '';
  const start = Math.max(before.lastIndexOf('}', open), before.lastIndexOf(';', open)) + 1;
  return before.slice(start, open).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim().slice(-160);
}

export function briefFontInputs(root) {
  const text = fs.readFileSync(path.join(root, BRIEF_RENDERER), 'utf8');
  const declarations = new Set();
  for (const m of text.matchAll(FONT_PROPS)) {
    const value = m[2].trim().replace(/['"`]\s*\+?\s*$/, '').replace(/\s+/g, ' ');
    declarations.add(`${selector(text, m.index)} | ${m[1]}: ${value}`);
  }
  const langs = new Set([...text.matchAll(LANG_ATTR)].map((m) => m[1].toLowerCase()));
  return { declarations: [...declarations].sort(), langs: [...langs].sort() };
}
