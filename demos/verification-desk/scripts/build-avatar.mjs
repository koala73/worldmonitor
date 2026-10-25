#!/usr/bin/env node
// Bundles HeyGen's LiveAvatar web SDK into one browser file the desk serves
// itself (public/vendor/liveavatar.js), so the stage never depends on a CDN.
// Runs automatically after npm install.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../public/vendor/liveavatar.js', import.meta.url));
await build({
  stdin: { contents: "export { LiveAvatarSession, SessionEvent, AgentEventsEnum, SessionState } from '@heygen/liveavatar-web-sdk';", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  outfile: out,
  logLevel: 'warning',
});
console.log(`LiveAvatar SDK bundled -> ${out}`);
