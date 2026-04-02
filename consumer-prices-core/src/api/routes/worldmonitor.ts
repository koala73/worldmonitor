import type { FastifyInstance } from 'fastify';
import {
  buildBasketSeriesSnapshot,
  buildCategoriesSnapshot,
  buildFreshnessSnapshot,
  buildMoversSnapshot,
  buildOverviewSnapshot,
  buildRetailerSpreadSnapshot,
} from '../../snapshots/worldmonitor.js';

export async function worldmonitorRoutes(fastify: FastifyInstance) {
  fastify.get('/overview', async (request, reply) => {
    const { market = 'ae' } = request.query as { market?: string };
    try {
      const data = await buildOverviewSnapshot(market);
      return reply.send(data);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'failed to build overview snapshot' });
    }
  });

  fastify.get('/movers', async (request, reply) => {
    const { market = 'ae', days = '30' } = request.query as { market?: string; days?: string };
    try {
      const data = await buildMoversSnapshot(market, parseInt(days, 10));
      return reply.send(data);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'failed to build movers snapshot' });
    }
  });

  fastify.get('/retailer-spread', async (request, reply) => {
    const { market = 'ae', basket = 'essentials-ae' } = request.query as {
      market?: string;
      basket?: string;
    };
    try {
      const data = await buildRetailerSpreadSnapshot(market, basket);
      return reply.send(data);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'failed to build retailer spread snapshot' });
    }
  });

  fastify.get('/freshness', async (request, reply) => {
    const { market = 'ae' } = request.query as { market?: string };
    try {
      const data = await buildFreshnessSnapshot(market);
      return reply.send(data);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'failed to build freshness snapshot' });
    }
  });

  fastify.get('/categories', async (request, reply) => {
    const { market = 'ae', range = '30d' } = request.query as { market?: string; range?: string };
    try {
      const data = await buildCategoriesSnapshot(market, range);
      return reply.send(data);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'failed to build categories snapshot' });
    }
  });

  fastify.get('/basket-series', async (request, reply) => {
    const { market = 'ae', basket = 'essentials-ae', range = '30d' } = request.query as {
      market?: string;
      basket?: string;
      range?: string;
    };
    try {
      const data = await buildBasketSeriesSnapshot(market, basket, range);
      return reply.send(data);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'failed to build basket series snapshot' });
    }
  });
}
