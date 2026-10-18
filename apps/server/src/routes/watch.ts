import type { FastifyInstance } from 'fastify';
import { toSymbol } from '../sources/tencent.js';
import {
  listWatchlist,
  addWatch,
  removeWatch,
  listFolders,
  addFolder,
  removeFolder,
  getStock,
  DEFAULT_FOLDER,
} from '../db/repo.js';
import { lastSnapshot } from '../service/poller.js';

/** 自选股与自选文件夹 */

export async function watchRoutes(app: FastifyInstance) {
  app.get('/api/watchlist', async () => {
    const [items, folders] = await Promise.all([listWatchlist(), listFolders()]);
    const snap = new Map(lastSnapshot().map((q) => [q.symbol, q]));
    return {
      items: items.map((it) => ({ ...it, quote: snap.get(it.symbol) ?? null })),
      folders,
    };
  });

  app.post('/api/watchlist', async (req, reply) => {
    const body = req.body as { symbol?: string; name?: string; grp?: string };
    const sym = toSymbol(body?.symbol ?? '');
    if (!sym || sym.length < 8) {
      reply.code(400);
      return { error: 'symbol 无效' };
    }
    let name = body?.name;
    if (!name) {
      const s = await getStock(sym);
      name = s?.name ?? sym;
    }
    try {
      await addWatch(sym, name, body?.grp);
    } catch (e) {
      reply.code(400);
      return { error: (e as Error).message };
    }
    return { ok: true, symbol: sym, name, grp: body?.grp ?? DEFAULT_FOLDER };
  });

  app.delete('/api/watchlist/:symbol', async (req) => {
    const { symbol } = req.params as { symbol: string };
    await removeWatch(toSymbol(symbol));
    return { ok: true };
  });

  /** 自选文件夹清单（含票数） */
  app.get('/api/watch/folders', async () => ({ folders: await listFolders() }));

  app.post('/api/watch/folders', async (req, reply) => {
    const body = req.body as { name?: string };
    try {
      const name = await addFolder(body?.name);
      return { ok: true, name };
    } catch (e) {
      reply.code(400);
      return { error: (e as Error).message };
    }
  });

  app.delete('/api/watch/folders/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      await removeFolder(decodeURIComponent(name));
      return { ok: true };
    } catch (e) {
      reply.code(400);
      return { error: (e as Error).message };
    }
  });
}
