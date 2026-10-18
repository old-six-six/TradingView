import type { FastifyInstance } from 'fastify';
import { toSymbol } from '../sources/tencent.js';
import { lastMarketCache, fetchAllMarket } from '../sources/sina.js';
import { fetchBoardStocks, fetchBoardQuotes, type BoardKind } from '../sources/tencentBoard.js';
import { query, esc } from '../db/sqlite.js';
import { boardBars } from '../service/boardIndex.js';
import { boardsOfStock, ensureBoardIndex, boardIndexCount, boardSyncState } from '../service/boardSync.js';
import { tagsOfStock, emTagSyncState } from '../service/emTagSync.js';
import { marketRows, marketLite, isMarketKey, MARKETS } from '../service/marketList.js';
import { resample } from '../service/kline.js';
import { calcIndicators } from '../engine/indicator.js';

/** 全市场排行/搜索、板块与五大市场列表 */

export async function marketRoutes(app: FastifyInstance) {
  app.get('/api/rank', async (req) => {
    const { sort = 'changePct', limit = '50', dir = 'desc' } = req.query as Record<string, string>;
    let { quotes } = lastMarketCache();
    if (!quotes.length) {
      try {
        quotes = await fetchAllMarket();
      } catch {
        return { items: [], at: 0, error: '全市场数据暂不可用' };
      }
    }
    const key = sort as keyof (typeof quotes)[number];
    const sorted = [...quotes].sort((a, b) => {
      const av = Number(a[key] ?? 0);
      const bv = Number(b[key] ?? 0);
      return dir === 'asc' ? av - bv : bv - av;
    });
    return {
      items: sorted.slice(0, Number(limit) || 50),
      at: lastMarketCache().at,
    };
  });

  app.get('/api/search', async (req) => {
    const { q } = req.query as { q?: string };
    const kw = (q ?? '').trim();
    if (!kw) return { items: [] };
    const safe = kw.replace(/'/g, "''");
    // 拼音首字母只存了小写，字面量也统一小写；代码/名称保持原样
    const low = safe.toLowerCase();
    // 排序按「像不像用户想要的」：代码精确 > 代码前缀 > 名称前缀 > 拼音全等 >
    // 拼音前缀 > 其余包含匹配。否则打 zg 会被一堆名称含「中国」的票淹没，
    // 打 byd 也会先撞上白云电器（bydq）而不是比亚迪（byd）
    const rows = await query<{ symbol: string; code: string; name: string }>(
      `SELECT symbol, code, name FROM stock
       WHERE code LIKE '%${safe}%' OR name LIKE '%${safe}%'
          OR py LIKE '%${low}%' OR py2 LIKE '%${low}%'
       ORDER BY
         CASE
           WHEN code = '${safe}' THEN 0
           WHEN code LIKE '${safe}%' THEN 1
           WHEN name LIKE '${safe}%' THEN 2
           WHEN py = '${low}' OR py2 = '${low}' THEN 3
           WHEN py LIKE '${low}%' OR py2 LIKE '${low}%' THEN 4
           ELSE 5
         END,
         LENGTH(py),
         symbol
       LIMIT 20`,
    );
    return { items: rows };
  });

  /**
   * 某只票所属的板块与概念。
   * 关系来自 board_member 反向索引，涨跌幅现拉腾讯实时覆盖（索引里的只是快照）。
   */
  app.get('/api/stock/boards', async (req) => {
    const { symbol } = req.query as { symbol?: string };
    const sym = toSymbol(symbol ?? '');
    if (!/^(sh|sz|bj)\d{6}$/.test(sym)) return { symbol: sym, boards: [], ready: false };

    const count = await boardIndexCount();
    if (!count) {
      // 索引还没建好：踢一次后台任务，先回空让前端显示「构建中」
      void ensureBoardIndex();
      return { symbol: sym, boards: [], ready: false, sync: boardSyncState() };
    }

    const boards = await boardsOfStock(sym);
    // 科创板 / 北交所的板块来自东财 F10，其中对不上腾讯板块名的只作标签展示
    const tags = await tagsOfStock(sym);
    let live: Awaited<ReturnType<typeof fetchBoardQuotes>> = [];
    try {
      live = await fetchBoardQuotes(boards.map((b) => b.code));
    } catch {
      /* 实时失败就用索引里的快照 */
    }
    const map = new Map(live.map((q) => [q.code, q]));
    return {
      symbol: sym,
      ready: true,
      sync: boardSyncState(),
      tagsSync: emTagSyncState(),
      boards: boards.map((b) => {
        const q = map.get(b.code);
        return {
          ...b,
          name: q?.name || b.name,
          changePct: q ? q.changePct : b.changePct,
          price: q?.price ?? 0,
        };
      }),
      tags,
    };
  });

  /** 板块 K 线。历史由成分股加权合成，详见 service/boardIndex.ts */
  app.get('/api/board/kline', async (req) => {
    const { code, period = 'day', limit = '400' } = req.query as Record<string, string>;
    const c = String(code ?? '').trim();
    if (!/^pt[0-9A-Za-z]+$/.test(c)) return { code: c, bars: [], series: null };
    const p = (['day', 'week', 'month'].includes(period) ? period : 'day') as
      | 'day'
      | 'week'
      | 'month';
    const n = Math.min(640, Math.max(20, Number(limit) || 400));
    const info = await boardMeta(c);
    const kind = (info.kind || 'gn') as BoardKind;
    const { bars: daily, cached } = await boardBars(c, kind, n);
    // 周/月由日线合并，避免为每种周期重复合成
    const bars = p === 'day' ? daily : resample(daily, p);
    return {
      code: c,
      name: info.name,
      kind,
      period: p,
      cached,
      bars,
      series: bars.length > 1 ? calcIndicators(bars) : null,
    };
  });

  /** 板块成分股，接口已按涨幅降序返回 */
  app.get('/api/board/stocks', async (req) => {
    const { code, kind } = req.query as Record<string, string>;
    const c = String(code ?? '').trim();
    if (!/^pt[0-9A-Za-z]+$/.test(c)) return { code: c, items: [] };
    const info = await boardMeta(c);
    const k = (['gn', 'hy', 'dy'].includes(kind) ? kind : info.kind || 'gn') as BoardKind;
    const items = await fetchBoardStocks(c, k, 800);
    return { code: c, name: info.name, kind: k, items };
  });

  /** 全市场列表：上证主板 / 深证主板 / 创业板 / 科创板 / 北交所 */
  app.get('/api/market/list', async (req) => {
    const { board = '' } = req.query as Record<string, string>;
    if (!isMarketKey(board)) {
      return { board, label: '', updatedAt: 0, cached: false, rows: [], error: 'unknown board' };
    }
    const { rows, at, cached } = await marketRows(board);
    return { board, label: MARKETS[board].label, updatedAt: at, cached, rows };
  });

  /** 板块精简名单（symbol/代码/名称/现价/涨幅），给左侧栏与键盘翻票用 */
  app.get('/api/market/lite', async (req) => {
    const { board = '' } = req.query as Record<string, string>;
    if (!isMarketKey(board)) return { board, at: 0, cached: false, rows: [] };
    return { board, ...(await marketLite(board)) };
  });
}

/** 板块的名称与类型，兜底从索引表查 */
async function boardMeta(code: string): Promise<{ name: string; kind: BoardKind | '' }> {
  const rows = await query<{ name: string; kind: string }>(
    `SELECT name, kind FROM board WHERE code = ${esc(code)} LIMIT 1`,
  );
  const row = rows[0];
  const kind = row?.kind;
  return {
    name: row?.name ?? code,
    kind: kind === 'gn' || kind === 'hy' || kind === 'dy' ? kind : '',
  };
}
