#!/usr/bin/env node
/**
 * Standalone God's Eye View API process.
 *
 * This is what docker's supervisord runs and what nginx proxies `/api/gev/`
 * to. In dev and preview the same app is mounted straight into Vite's
 * middleware stack instead (see the `gev-api` plugin in vite.config.ts), and
 * in the Tauri desktop build it is mounted into the sidecar — three mounts,
 * one implementation.
 *
 * Configuration:
 *   GEV_API_PORT   port to listen on          (default 46124)
 *   GEV_API_HOST   interface to bind          (default 127.0.0.1)
 *
 * The default bind is loopback ON PURPOSE. This process brokers the
 * operator's Google, TomTom, OpenAI, OpenSky and AISStream credentials —
 * anyone who can reach it can spend that quota. nginx sits in front of it in
 * docker; nothing else should be able to reach it directly.
 */

import http from 'node:http';
import { createGevApiApp, GEV_API_PREFIX } from './gev-api-server.mjs';

const PORT = Number.parseInt(process.env.GEV_API_PORT ?? '46124', 10);
const HOST = process.env.GEV_API_HOST ?? '127.0.0.1';

const server = http.createServer();

// The AIS live proxy attaches a websocket upgrade handler, so it needs the
// real server instance — pass it before any request can arrive.
const { app, routes } = await createGevApiApp({
  httpServer: server,
  mode: process.env.NODE_ENV === 'development' ? 'development' : 'production',
});

server.on('request', (req, res) => {
  app(req, res, () => {
    // Nothing in the GEV app claimed it. Answer definitively rather than
    // letting the socket hang — a hung request here looks like an upstream
    // timeout and sends people hunting in the wrong place.
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'not_found',
      hint: `God's Eye View serves ${routes.length} routes under ${GEV_API_PREFIX}`,
    }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[gev-api] listening on http://${HOST}:${PORT}`);
  console.log(`[gev-api] ${routes.length} routes under ${GEV_API_PREFIX}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[gev-api] ${signal} — closing`);
    server.close(() => process.exit(0));
    // Don't let a lingering keep-alive socket hold the container open.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
