import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db/client.js';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};

    try {
      await getPool().query('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'fail';
    }

    const healthy = Object.values(checks).every((v) => v === 'ok');
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  });
}
