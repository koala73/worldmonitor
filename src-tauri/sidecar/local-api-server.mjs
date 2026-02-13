#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function isBracketSegment(segment) {
  return segment.startsWith('[') && segment.endsWith(']');
}

function splitRoutePath(routePath) {
  return routePath.split('/').filter(Boolean);
}

function routePriority(routePath) {
  const parts = splitRoutePath(routePath);
  return parts.reduce((score, part) => {
    if (part.startsWith('[[...') && part.endsWith(']]')) return score + 0;
    if (part.startsWith('[...') && part.endsWith(']')) return score + 1;
    if (isBracketSegment(part)) return score + 2;
    return score + 10;
  }, 0);
}

function matchRoute(routePath, pathname) {
  const routeParts = splitRoutePath(routePath);
  const pathParts = splitRoutePath(pathname.replace(/^\/api/, ''));

  let i = 0;
  let j = 0;

  while (i < routeParts.length && j < pathParts.length) {
    const routePart = routeParts[i];
    const pathPart = pathParts[j];

    if (routePart.startsWith('[[...') && routePart.endsWith(']]')) {
      return true;
    }

    if (routePart.startsWith('[...') && routePart.endsWith(']')) {
      return true;
    }

    if (isBracketSegment(routePart)) {
      i += 1;
      j += 1;
      continue;
    }

    if (routePart !== pathPart) {
      return false;
    }

    i += 1;
    j += 1;
  }

  if (i === routeParts.length && j === pathParts.length) return true;

  if (i === routeParts.length - 1) {
    const tail = routeParts[i];
    if (tail?.startsWith('[[...') && tail.endsWith(']]')) {
      return true;
    }
    if (tail?.startsWith('[...') && tail.endsWith(']')) {
      return j < pathParts.length;
    }
  }

  return false;
}

async function buildRouteTable(root) {
  if (!existsSync(root)) return [];

  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name.startsWith('_')) continue;

      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      const routePath = relative.replace(/\.js$/, '').replace(/\/index$/, '');
      files.push({ routePath, modulePath: absolute });
    }
  }

  await walk(root);

  files.sort((a, b) => routePriority(b.routePath) - routePriority(a.routePath));
  return files;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function toHeaders(nodeHeaders, options = {}) {
  const stripOrigin = options.stripOrigin === true;
  const headers = new Headers();
  Object.entries(nodeHeaders).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host') return;
    if (stripOrigin && (lowerKey === 'origin' || lowerKey === 'referer' || lowerKey.startsWith('sec-fetch-'))) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(v => headers.append(key, v));
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  });
  return headers;
}

async function proxyToCloud(requestUrl, req, remoteBase) {
  const target = `${remoteBase}${requestUrl.pathname}${requestUrl.search}`;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  return fetch(target, {
    method: req.method,
    // Strip browser-origin headers for server-to-server parity.
    headers: toHeaders(req.headers, { stripOrigin: true }),
    body,
  });
}

function pickModule(pathname, routes) {
  const apiPath = pathname.startsWith('/api') ? pathname.slice(4) || '/' : pathname;

  for (const candidate of routes) {
    if (matchRoute(candidate.routePath, apiPath)) {
      return candidate.modulePath;
    }
  }

  return null;
}

const moduleCache = new Map();
const failedImports = new Set();
const fallbackCounts = new Map();
const cloudPreferred = new Set();

async function importHandler(modulePath) {
  if (failedImports.has(modulePath)) {
    throw new Error(`cached-failure:${path.basename(modulePath)}`);
  }

  const cached = moduleCache.get(modulePath);
  if (cached) return cached;

  try {
    const mod = await import(pathToFileURL(modulePath).href);
    moduleCache.set(modulePath, mod);
    return mod;
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      failedImports.add(modulePath);
    }
    throw error;
  }
}

function resolveConfig(options = {}) {
  const port = Number(options.port ?? process.env.LOCAL_API_PORT ?? 46123);
  const remoteBase = String(options.remoteBase ?? process.env.LOCAL_API_REMOTE_BASE ?? 'https://worldmonitor.app').replace(/\/$/, '');
  const resourceDir = String(options.resourceDir ?? process.env.LOCAL_API_RESOURCE_DIR ?? process.cwd());
  const apiDir = options.apiDir
    ? String(options.apiDir)
    : [
      path.join(resourceDir, 'api'),
      path.join(resourceDir, '_up_', 'api'),
    ].find((candidate) => existsSync(candidate)) ?? path.join(resourceDir, 'api');
  const mode = String(options.mode ?? process.env.LOCAL_API_MODE ?? 'desktop-sidecar');
  const logger = options.logger ?? console;

  return {
    port,
    remoteBase,
    resourceDir,
    apiDir,
    mode,
    logger,
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

async function handleLocalServiceStatus(context) {
  return json({
    success: true,
    timestamp: new Date().toISOString(),
    summary: { operational: 2, degraded: 0, outage: 0, unknown: 0 },
    services: [
      { id: 'local-api', name: 'Local Desktop API', category: 'dev', status: 'operational', description: `Running on 127.0.0.1:${context.port}` },
      { id: 'cloud-pass-through', name: 'Cloud pass-through', category: 'cloud', status: 'operational', description: `Fallback target ${context.remoteBase}` },
    ],
    local: { enabled: true, mode: context.mode, port: context.port, remoteBase: context.remoteBase },
  });
}

async function tryCloudFallback(requestUrl, req, context, reason) {
  if (reason) {
    const route = requestUrl.pathname;
    const count = (fallbackCounts.get(route) || 0) + 1;
    fallbackCounts.set(route, count);
    if (count === 1) {
      const brief = reason instanceof Error
        ? (reason.code === 'ERR_MODULE_NOT_FOUND' ? 'missing npm dependency' : reason.message)
        : reason;
      context.logger.warn(`[local-api] ${route} → cloud (${brief})`);
    } else if (count === 5 || count % 100 === 0) {
      context.logger.warn(`[local-api] ${route} → cloud x${count}`);
    }
  }
  try {
    return await proxyToCloud(requestUrl, req, context.remoteBase);
  } catch (error) {
    context.logger.error('[local-api] cloud fallback failed', requestUrl.pathname, error);
    return null;
  }
}

async function dispatch(requestUrl, req, routes, context) {
  if (requestUrl.pathname === '/api/service-status') {
    return handleLocalServiceStatus(context);
  }
  if (requestUrl.pathname === '/api/local-status') {
    return json({
      success: true,
      mode: context.mode,
      port: context.port,
      apiDir: context.apiDir,
      remoteBase: context.remoteBase,
      routes: routes.length,
    });
  }

  if (cloudPreferred.has(requestUrl.pathname)) {
    const cloudResponse = await tryCloudFallback(requestUrl, req, context);
    if (cloudResponse) return cloudResponse;
  }

  const modulePath = pickModule(requestUrl.pathname, routes);
  if (!modulePath || !existsSync(modulePath)) {
    const cloudResponse = await tryCloudFallback(requestUrl, req, context, 'handler missing');
    if (cloudResponse) return cloudResponse;
    return json({ error: 'Local handler missing and cloud fallback unavailable' }, 502);
  }

  try {
    const mod = await importHandler(modulePath);
    if (typeof mod.default !== 'function') {
      const cloudResponse = await tryCloudFallback(requestUrl, req, context, `invalid handler module ${path.basename(modulePath)}`);
      if (cloudResponse) return cloudResponse;
      return json({ error: `Invalid handler module: ${path.basename(modulePath)}` }, 500);
    }

    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const request = new Request(requestUrl.toString(), {
      method: req.method,
      // Local handler execution does not need browser-origin metadata.
      headers: toHeaders(req.headers, { stripOrigin: true }),
      body,
    });

    const response = await mod.default(request);
    if (!(response instanceof Response)) {
      const cloudResponse = await tryCloudFallback(requestUrl, req, context, 'handler returned non-Response');
      if (cloudResponse) { cloudPreferred.add(requestUrl.pathname); return cloudResponse; }
      return json({ error: `Handler returned invalid response for ${requestUrl.pathname}` }, 500);
    }

    // Local handlers can return 4xx/5xx when desktop keys are missing.
    // Prefer cloud parity response when available.
    if (!response.ok) {
      const cloudResponse = await tryCloudFallback(requestUrl, req, context, `local status ${response.status}`);
      if (cloudResponse) { cloudPreferred.add(requestUrl.pathname); return cloudResponse; }
    }

    return response;
  } catch (error) {
    const cloudResponse = await tryCloudFallback(requestUrl, req, context, error);
    if (cloudResponse) { cloudPreferred.add(requestUrl.pathname); return cloudResponse; }
    return json({ error: 'Local handler failed and cloud fallback unavailable' }, 502);
  }
}

export async function createLocalApiServer(options = {}) {
  const context = resolveConfig(options);
  const routes = await buildRouteTable(context.apiDir);

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${context.port}`);

    if (!requestUrl.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    try {
      const response = await dispatch(requestUrl, req, routes, context);
      const body = Buffer.from(await response.arrayBuffer());
      const headers = Object.fromEntries(response.headers.entries());
      res.writeHead(response.status, headers);
      res.end(body);
    } catch (error) {
      context.logger.error('[local-api] fatal', error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  return {
    context,
    routes,
    server,
    async start() {
      await new Promise((resolve, reject) => {
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };

        server.once('listening', onListening);
        server.once('error', onError);
        server.listen(context.port, '127.0.0.1');
      });

      const address = server.address();
      const boundPort = typeof address === 'object' && address?.port ? address.port : context.port;
      context.logger.log(`[local-api] listening on http://127.0.0.1:${boundPort} (apiDir=${context.apiDir}, routes=${routes.length})`);
      return { port: boundPort };
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

if (isMainModule()) {
  try {
    const app = await createLocalApiServer();
    await app.start();
  } catch (error) {
    console.error('[local-api] startup failed', error);
    process.exit(1);
  }
}
