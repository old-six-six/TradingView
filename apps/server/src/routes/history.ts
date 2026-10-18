import type { FastifyInstance } from 'fastify';
import { historyStatus, startHistory, stopHistory } from '../service/history.js';

/** 全市场历史回填：查进度、启动、停止 */

export async function historyRoutes(app: FastifyInstance) {
  app.get('/api/history/status', async () => historyStatus());

  app.post('/api/history/start', async (req) => {
    const b = (req.body ?? {}) as { concurrency?: number; limit?: number; refresh?: boolean };
    return startHistory({
      concurrency: Number(b.concurrency) || undefined,
      limit: Number(b.limit) || undefined,
      refresh: !!b.refresh,
    });
  });

  app.post('/api/history/stop', async () => stopHistory());
}
