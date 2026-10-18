import type { FastifyInstance } from 'fastify';
import { toSymbol } from '../sources/tencent.js';
import { listPositions, addPosition, closePosition } from '../db/repo.js';
import { lastSnapshot } from '../service/poller.js';

/** 持仓（成本/股数/浮盈），与实时快照合并后返回 */

export async function positionRoutes(app: FastifyInstance) {
  app.get('/api/positions', async () => {
    const rows = await listPositions();
    const snap = new Map(lastSnapshot().map((q) => [q.symbol, q]));
    return {
      items: rows.map((p) => {
        const q = snap.get(p.symbol);
        const price = q?.price ?? 0;
        const pnl = price ? (price - p.cost_price) * p.shares : 0;
        return {
          ...p,
          name: q?.name ?? p.symbol,
          price,
          pnl,
          pnlPct: p.cost_price ? ((price - p.cost_price) / p.cost_price) * 100 : 0,
        };
      }),
    };
  });

  app.post('/api/positions', async (req, reply) => {
    const b = req.body as {
      symbol?: string;
      shares?: number;
      costPrice?: number;
      openPrice?: number;
      note?: string;
    };
    const sym = toSymbol(b?.symbol ?? '');
    if (!sym || sym.length < 8 || !b?.shares || !b?.costPrice) {
      reply.code(400);
      return { error: '参数不完整' };
    }
    await addPosition({
      id: `${sym}-${Date.now()}`,
      symbol: sym,
      shares: Number(b.shares),
      costPrice: Number(b.costPrice),
      openPrice: Number(b.openPrice ?? b.costPrice),
      openedAt: new Date().toISOString(),
      note: b.note,
    });
    return { ok: true };
  });

  app.delete('/api/positions/:id', async (req) => {
    const { id } = req.params as { id: string };
    await closePosition(id);
    return { ok: true };
  });
}
