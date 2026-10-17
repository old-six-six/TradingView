import { initDb, closeDb } from '../db/sqlite.js';
import { upsertStocks, stockCount, addWatch, listWatchlist, getSetting, setSetting } from '../db/repo.js';
import { fetchStocks } from '../sources/sina.js';
import { syncMany } from '../service/sync.js';

const DEFAULT_WATCH: Array<[string, string]> = [
  ['sh600685', '中船防务'],
  ['sh600746', '江苏索普'],
  ['sh600765', '中航重机'],
  ['sh600150', '中国船舶'],
  ['sh601899', '紫金矿业'],
  ['sh600000', '浦发银行'],
];

async function main() {
  const args = new Set(process.argv.slice(2));
  await initDb();

  if (!args.has('--skip-stocks')) {
    const before = await stockCount();
    if (before < 100 || args.has('--force-stocks')) {
      console.log('拉取全市场股票列表…');
      const stocks = await fetchStocks();
      await upsertStocks(stocks);
      console.log(`股票列表 ${stocks.length} 只`);
    } else {
      console.log(`股票列表已存在 ${before} 只，跳过`);
    }
  }

  if (!args.has('--skip-watch')) {
    const seeded = await getSetting('seeded');
    if (!seeded) {
      for (const [symbol, name] of DEFAULT_WATCH) await addWatch(symbol, name);
      await setSetting('seeded', '1');
      console.log(`写入默认自选 ${DEFAULT_WATCH.length} 只`);
    }
  }

  const items = await listWatchlist();
  if (items.length && !args.has('--skip-kline')) {
    console.log(`同步 ${items.length} 只票日 K + 指标…`);
    const t0 = Date.now();
    const results = await syncMany(items.map((i) => i.symbol), (done, total, r) => {
      process.stdout.write(
        `  [${done}/${total}] ${r.symbol} ${r.ok ? `${r.bars} 根` : `失败 ${r.error}`}\n`,
      );
    });
    const ok = results.filter((r) => r.ok).length;
    console.log(`完成 ${ok}/${results.length}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
