import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { worldmonitorRoutes } from './routes/worldmonitor.js';
import { healthRoutes } from './routes/health.js';

const server = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await server.register(cors, {
  origin: process.env.CORS_ORIGIN ?? '*',
  methods: ['GET'],
});

const API_KEY = process.env.WORLDMONITOR_SNAPSHOT_API_KEY;

server.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return;

  if (API_KEY) {
    const provided = request.headers['x-api-key'];
    if (provided !== API_KEY) {
      await reply.status(401).send({ error: 'unauthorized' });
    }
  }
});

await server.register(worldmonitorRoutes, { prefix: '/wm/consumer-prices/v1' });
await server.register(healthRoutes, { prefix: '/health' });

const port = parseInt(process.env.PORT ?? '3400', 10);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await server.listen({ port, host });
  console.log(`consumer-prices-core listening on ${host}:${port}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
