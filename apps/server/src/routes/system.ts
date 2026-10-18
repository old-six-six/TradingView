import type { FastifyInstance } from 'fastify';
import { sourceHealth, isCircuitOpen } from '../sources/gateway.js';
import { lastMarketCache } from '../sources/sina.js';
import { stockCount } from '../db/repo.js';
import { lastSnapshot, isTradingTime } from '../service/poller.js';

/** 运维信息：健康检查、数据源状态 */

export async function systemRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    const quotes = lastMarketCache();
    return {
      ok: true,
      trading: isTradingTime(),
      circuitOpen: isCircuitOpen(),
      sources: sourceHealth(),
      stocks: await stockCount(),
      marketCache: { size: quotes.quotes.length, at: quotes.at },
      snapshotSize: lastSnapshot().length,
    };
  });
}
