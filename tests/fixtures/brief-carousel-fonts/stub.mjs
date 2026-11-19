// fetch stub for carousel renders: serves the committed fixture fonts for
// Google Fonts requests and the base font URL, and logs every font request.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const BASE_FONT = readFileSync(resolve(DIR, '../../../blog-site/scripts/fonts/inter-regular.ttf'));
export const BASE_FONT_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff';

const urlOf = (input) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const marked = (init) => new Headers(init?.headers).get('X-WM-Carousel') === '1';
const fileFor = (family) => `${family.replaceAll('+', '-').replaceAll(' ', '-').toLowerCase()}.ttf`;

/**
 * @param {{ fallback?: (url: string, init?: RequestInit) => Response | Promise<Response>, fail?: string, garbage?: string, timeout?: string }} [opts]
 *   fail / garbage / timeout name a family whose css request returns 500, whose font is not a font, or whose fetch times out.
 */
export function installFontStub(opts = {}) {
  const log = { loader: [], vendored: [] };
  globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    if (url === BASE_FONT_URL) return new Response(BASE_FONT, { status: 200 });
    const u = new URL(url);
    if (u.hostname === 'fonts.googleapis.com') {
      const family = (u.searchParams.get('family') ?? '').replaceAll(' ', '+');
      (marked(init) ? log.loader : log.vendored).push(family);
      if (family === opts.timeout) throw new DOMException('The operation timed out.', 'TimeoutError');
      if (family === opts.fail) return new Response('nope', { status: 500 });
      return new Response(`@font-face { src: url(https://fonts.fixture.invalid/${family}) format('truetype'); }`, { status: 200 });
    }
    if (u.hostname === 'fonts.fixture.invalid') {
      const family = u.pathname.slice(1);
      if (family === opts.garbage) return new Response(new Uint8Array(64).fill(7), { status: 200 });
      return new Response(readFileSync(resolve(DIR, fileFor(family))), { status: 200 });
    }
    if (opts.fallback) return opts.fallback(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  return log;
}
