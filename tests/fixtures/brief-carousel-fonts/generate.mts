// Regenerates the carousel test fonts from Google Fonts (needs network):
//   npx tsx tests/fixtures/brief-carousel-fonts/generate.mts [png-output-dir]
// Each <family>.ttf is a `text=` subset covering every character the
// fixture briefs draw. With a directory argument it also writes every
// fixture page as a PNG for visual inspection.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carouselPageText, loadCarouselFonts, renderCarouselImageResponse, type CarouselPage } from '../../../server/_shared/brief-carousel-render.ts';
import { CAROUSEL_FIXTURES } from './envelopes.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const PAGES: CarouselPage[] = ['cover', 'threads', 'story'];
const UA = 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1';

const realFetch = globalThis.fetch;
const charsByFamily = new Map<string, Set<string>>();
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === 'fonts.googleapis.com') {
    const family = url.searchParams.get('family')!.replaceAll(' ', '+');
    if (!charsByFamily.has(family)) charsByFamily.set(family, new Set());
    for (const ch of url.searchParams.get('text') ?? '') charsByFamily.get(family)!.add(ch);
  }
  return realFetch(input, init);
}) as typeof fetch;

for (const [lang, envelope] of Object.entries(CAROUSEL_FIXTURES)) {
  for (const page of PAGES) await loadCarouselFonts(carouselPageText(envelope as never, page), lang);
}
globalThis.fetch = realFetch;

for (const [family, chars] of charsByFamily) {
  const text = [...chars].sort().join('');
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family}&text=${encodeURIComponent(text)}`, { headers: { 'User-Agent': UA } })).text();
  const src = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
  if (!src) throw new Error(`no truetype font for ${family}`);
  const data = new Uint8Array(await (await fetch(src, { headers: { 'User-Agent': UA } })).arrayBuffer());
  const file = `${family.replaceAll('+', '-').toLowerCase()}.ttf`;
  writeFileSync(resolve(DIR, file), data);
  console.log(`${file}: ${data.byteLength} B, ${chars.size} chars`);
}

const out = process.argv[2];
if (out) {
  mkdirSync(out, { recursive: true });
  for (const [lang, envelope] of Object.entries(CAROUSEL_FIXTURES)) {
    for (const page of PAGES) {
      const res = await renderCarouselImageResponse(envelope as never, page);
      writeFileSync(resolve(out, `${lang}-${page}.png`), new Uint8Array(await res.arrayBuffer()));
    }
  }
  console.log(`wrote PNGs to ${out}`);
}
