import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, { type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { worldmonitorRoutes } from './routes/worldmonitor.js';
import { healthRoutes } from './routes/health.js';

export interface ConsumerPricesServerOptions {
  apiKey?: string;
  corsOrigin?: string;
  logger?: FastifyServerOptions['logger'];
}

function requiredApiKey(apiKey = process.env.WORLDMONITOR_SNAPSHOT_API_KEY): string {
  const normalized = apiKey?.trim();
  if (!normalized) throw new Error('WORLDMONITOR_SNAPSHOT_API_KEY is required for consumer-prices-core API startup');
  return normalized;
}

export function isHealthCheckPath(url: string): boolean {
  return url.split('?', 1)[0] === '/health';
}

function matchesApiKey(candidate: string, apiKey: Buffer): boolean {
  const candidateBuffer = Buffer.from(candidate);
  return candidateBuffer.length === apiKey.length && timingSafeEqual(candidateBuffer, apiKey);
}

function isAuthorizedApiKey(provided: string | string[] | undefined, apiKey: Buffer): boolean {
  if (!provided) return false;
  const candidates = Array.isArray(provided) ? provided : [provided];
  return candidates.some((candidate) => matchesApiKey(candidate, apiKey));
}

export function createServer(options: ConsumerPricesServerOptions = {}) {
  const apiKey = Buffer.from(requiredApiKey(options.apiKey));
  const server = Fastify({ logger: options.logger ?? { level: process.env.LOG_LEVEL ?? 'info' } });

  server.register(cors, {
    origin: options.corsOrigin ?? process.env.CORS_ORIGIN ?? '*',
    methods: ['GET'],
  });

  server.addHook('onRequest', async (request, reply) => {
    if (isHealthCheckPath(request.url)) return;

    const provided = request.headers['x-api-key'];
    if (!isAuthorizedApiKey(provided, apiKey)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
  });

  server.register(worldmonitorRoutes, { prefix: '/wm/consumer-prices/v1' });
  server.register(healthRoutes, { prefix: '/health' });

  return server;
}

function isInvokedAsScript(entryPath: string | undefined, moduleUrl: string): boolean {
  if (!entryPath) return false;
  try {
    const entry = pathToFileURL(realpathSync(entryPath)).href;
    const self = pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
    return entry === self;
  } catch {
    return moduleUrl === pathToFileURL(entryPath).href;
  }
}

export async function startServer() {
  const server = createServer();
  const port = parseInt(process.env.PORT ?? '3400', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  try {
    await server.listen({ port, host });
    console.log(`consumer-prices-core listening on ${host}:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

if (isInvokedAsScript(process.argv[1], import.meta.url)) {
  await startServer();
}
