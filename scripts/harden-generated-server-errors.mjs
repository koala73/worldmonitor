import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isMainModule } from './lib/main-module.mjs';

const unsafeFallback = 'const message = err instanceof Error ? err.message : String(err);';
const safeFallback = 'const message = "Internal server error";';

export function hardenServerErrors(source) {
  const routeCount = [...source.matchAll(/^\s+path: "\/api\/[^"\n]+",$/gm)].length;
  const fallbackCount = source.split(unsafeFallback).length - 1
    + source.split(safeFallback).length - 1;
  if (routeCount === 0 || routeCount !== fallbackCount) {
    throw new Error(`Unrecognized sebuf error template: ${routeCount} routes, ${fallbackCount} fallbacks`);
  }
  return source.replaceAll(unsafeFallback, safeFallback);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const check = process.argv.includes('--check');
  const root = new URL('../src/generated/server/worldmonitor/', import.meta.url);
  const files = readdirSync(root, { recursive: true })
    .filter((file) => file.endsWith('/service_server.ts'));
  if (files.length === 0) throw new Error('No generated sebuf servers found');
  for (const file of files) {
    const path = new URL(file, root);
    const source = readFileSync(path, 'utf8');
    const hardened = hardenServerErrors(source);
    if (check && hardened !== source) throw new Error(`${file} exposes exception details; run make generate`);
    if (hardened !== source) writeFileSync(path, hardened);
  }
  console.log(`${check ? 'Validated' : 'Hardened'} error fallbacks in ${files.length} generated services`);
}
