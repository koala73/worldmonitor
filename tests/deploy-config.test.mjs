import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));
const viteConfigSource = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf-8');

const getCacheHeaderValue = (sourcePath) => {
  const rule = vercelConfig.headers.find((entry) => entry.source === sourcePath);
  const header = rule?.headers?.find((item) => item.key.toLowerCase() === 'cache-control');
  return header?.value ?? null;
};

describe('deploy/cache configuration guardrails', () => {
  it('disables caching for HTML entry routes on Vercel', () => {
    const spaNoCache = getCacheHeaderValue('/((?!api|assets|blog|docs|favico|map-styles|data|textures|pro|sw\\.js|workbox-[a-f0-9]+\\.js|manifest\\.webmanifest|offline\\.html|robots\\.txt|sitemap\\.xml|llms\\.txt|llms-full\\.txt|\\.well-known).*)');
    assert.equal(spaNoCache, 'no-cache, no-store, must-revalidate');
  });

  it('keeps immutable caching for hashed static assets', () => {
    assert.equal(
      getCacheHeaderValue('/assets/(.*)'),
      'public, max-age=31536000, immutable'
    );
  });

  it('keeps PWA precache glob free of HTML files', () => {
    assert.match(
      viteConfigSource,
      /globPatterns:\s*\['\*\*\/\*\.\{js,css,ico,png,svg,woff2\}'\]/
    );
    assert.doesNotMatch(viteConfigSource, /globPatterns:\s*\['\*\*\/\*\.\{js,css,html/);
  });

  it('explicitly disables navigateFallback when HTML is not precached', () => {
    assert.match(viteConfigSource, /navigateFallback:\s*null/);
    assert.doesNotMatch(viteConfigSource, /navigateFallbackDenylist:\s*\[/);
  });

  it('uses network-only runtime caching for navigation requests', () => {
    assert.match(viteConfigSource, /request\.mode === 'navigate'/);
    assert.match(viteConfigSource, /handler:\s*'NetworkOnly'/);
  });

  it('contains variant-specific metadata fields used by html replacement and manifest', () => {
    const variantMetaSource = readFileSync(resolve(__dirname, '../src/config/variant-meta.ts'), 'utf-8');
    assert.match(variantMetaSource, /shortName:\s*'/);
    assert.match(variantMetaSource, /subject:\s*'/);
    assert.match(variantMetaSource, /classification:\s*'/);
    assert.match(variantMetaSource, /categories:\s*\[/);
    assert.match(
      viteConfigSource,
      /\.replace\(\/<meta name="subject" content="\.\*\?" \\\/>\/,\s*`<meta name="subject"/
    );
    assert.match(
      viteConfigSource,
      /\.replace\(\/<meta name="classification" content="\.\*\?" \\\/>\/,\s*`<meta name="classification"/
    );
  });
});

const getSecurityHeaders = () => {
  const rule = vercelConfig.headers.find((entry) => entry.source === '/((?!docs).*)');
  return rule?.headers ?? [];
};

const getHeaderValue = (key) => {
  const headers = getSecurityHeaders();
  const header = headers.find((h) => h.key.toLowerCase() === key.toLowerCase());
  return header?.value ?? null;
};

describe('security header guardrails', () => {
  it('includes all 5 required security headers on catch-all route', () => {
    const required = [
      'X-Content-Type-Options',
      'Strict-Transport-Security',
      'Referrer-Policy',
      'Permissions-Policy',
      'Content-Security-Policy',
    ];
    const headerKeys = getSecurityHeaders().map((h) => h.key);
    for (const name of required) {
      assert.ok(headerKeys.includes(name), `Missing security header: ${name}`);
    }
  });

  it('Permissions-Policy disables all expected browser APIs', () => {
    const policy = getHeaderValue('Permissions-Policy');
    const expectedDisabled = [
      'camera=()',
      'microphone=()',
      'geolocation=(self)',
      'accelerometer=()',
      'bluetooth=()',
      'display-capture=()',
      'gyroscope=()',
      'hid=()',
      'idle-detection=()',
      'magnetometer=()',
      'midi=()',
      'payment=()',
      'screen-wake-lock=()',
      'serial=()',
      'usb=()',
      'xr-spatial-tracking=()',
    ];
    for (const directive of expectedDisabled) {
      assert.ok(policy.includes(directive), `Permissions-Policy missing: ${directive}`);
    }
  });

  it('Permissions-Policy delegates media APIs to allowed origins', () => {
    const policy = getHeaderValue('Permissions-Policy');
    // autoplay and encrypted-media delegate to self + YouTube
    for (const api of ['autoplay', 'encrypted-media']) {
      assert.match(
        policy,
        new RegExp(`${api}=\\(self "https://www\\.youtube\\.com" "https://www\\.youtube-nocookie\\.com"\\)`),
        `Permissions-Policy should delegate ${api} to YouTube origins`
      );
    }
    // picture-in-picture also includes Cloudflare challenges
    assert.match(
      policy,
      /picture-in-picture=\(self "https:\/\/www\.youtube\.com" "https:\/\/www\.youtube-nocookie\.com" "https:\/\/challenges\.cloudflare\.com"\)/,
      'Permissions-Policy should delegate picture-in-picture to YouTube + Cloudflare origins'
    );
  });

  it('CSP connect-src does not allow unencrypted WebSocket (ws:)', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const connectSrc = csp.match(/connect-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(!connectSrc.includes(' ws:'), 'CSP connect-src must not contain ws: (unencrypted WebSocket)');
    assert.ok(connectSrc.includes('wss:'), 'CSP connect-src should keep wss: for secure WebSocket');
  });

  it('CSP connect-src does not contain localhost in production', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const connectSrc = csp.match(/connect-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(!connectSrc.includes('http://localhost'), 'CSP connect-src must not contain http://localhost in production');
  });

  it('CSP script-src includes wasm-unsafe-eval for WebAssembly support', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"), 'CSP script-src must include wasm-unsafe-eval for WASM support');
    assert.ok(scriptSrc.includes("'self'"), 'CSP script-src must include self');
  });

  it('security.txt exists in public/.well-known/', () => {
    const secTxt = readFileSync(resolve(__dirname, '../public/.well-known/security.txt'), 'utf-8');
    assert.match(secTxt, /^Contact:/m, 'security.txt must have a Contact field');
    assert.match(secTxt, /^Expires:/m, 'security.txt must have an Expires field');
  });
});
