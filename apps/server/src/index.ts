import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PORT } from './config.js';
import { initDb } from './db/sqlite.js';
import {
  listWatchlist,
  addWatch,
  listPositions,
  getSetting,
  setSetting,
  upsertStocks,
  stockCount,
} from './db/repo.js';
import { apiRoutes } from './routes/api.js';
import { setupWs } from './routes/ws.js';
import { setWatchProvider, startPoller } from './service/poller.js';
import { syncMany } from './service/sync.js';
import { fetchStocks, fetchAllMarket } from './sources/sina.js';
import { toSymbol } from './sources/tencent.js';

const DEFAULT_WATCH: Array<[string, string]> = [
  ['sh600685', '中船防务'],
  ['sh600746', '江苏索普'],
  ['sh600765', '中航重机'],
  ['sh600150', '中国船舶'],
  ['sh601899', '紫金矿业'],
  ['sh600000', '浦发银行'],
];

async function main() {
  await initDb();
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await apiRoutes(app);
  setupWs(app);

  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`[server] http://127.0.0.1:${PORT}`);

  setWatchProvider(async () => {
    const [w, p] = await Promise.all([listWatchlist(), listPositions()]);
    return [...new Set([...w.map((x) => x.symbol), ...p.map((x) => x.symbol)])];
  });
  startPoller();

  void bootstrap();
}

async function bootstrap() {
  try {
    const seeded = await getSetting('seeded');
    if (!seeded) {
      for (const [symbol, name] of DEFAULT_WATCH) {
        await addWatch(symbol, name);
      }
      await setSetting('seeded', '1');
      console.log(`[bootstrap] 已写入 ${DEFAULT_WATCH.length} 只默认自选`);
    }
  } catch (e) {
    console.error('[bootstrap] 初始化自选失败', (e as Error).message);
  }

  void (async () => {
    try {
      const count = await stockCount();
      if (count < 100) {
        console.log('[bootstrap] 正在拉取全市场股票列表…');
        const quotes = await fetchAllMarket();
        await upsertStocks(
          quotes.map((q) => ({
            symbol: q.symbol,
            code: q.code,
            name: q.name,
            market: q.symbol.slice(0, 2).toUpperCase(),
          })),
        );
        console.log(`[bootstrap] 股票列表 ${quotes.length} 只`);
      } else {
        void fetchAllMarket().catch(() => undefined);
      }
    } catch (e) {
      console.error('[bootstrap] 股票列表失败', (e as Error).message);
    }
  })();

  void (async () => {
    try {
      const items = await listWatchlist();
      const symbols = items.map((i) => toSymbol(i.symbol));
      if (!symbols.length) return;
      console.log(`[bootstrap] 同步 ${symbols.length} 只票的日 K…`);
      const t0 = Date.now();
      const results = await syncMany(symbols);
      const ok = results.filter((r) => r.ok).length;
      console.log(`[bootstrap] 日 K 同步完成 ${ok}/${results.length}，耗时 ${Date.now() - t0}ms`);
    } catch (e) {
      console.error('[bootstrap] 日 K 同步失败', (e as Error).message);
    }
  })();
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
