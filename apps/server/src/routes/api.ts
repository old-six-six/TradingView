import type { FastifyInstance } from 'fastify';
import { getQuotes, sourceHealth, isCircuitOpen } from '../sources/gateway.js';
import { toSymbol, fetchMinute, fetchKline, fetchKlineDeep, KLINE_PAGE } from '../sources/tencent.js';
import { fetchKlineFull } from '../sources/eastmoney.js';
import { lastMarketCache, fetchAllMarket, fetchMinuteKline } from '../sources/sina.js';
import {
  getDailyBars,
  getIndicators,
  upsertDailyBars,
  listWatchlist,
  addWatch,
  removeWatch,
  listPositions,
  addPosition,
  closePosition,
  getStock,
  stockCount,
} from '../db/repo.js';
import { aggregateMinute } from '../engine/minute-agg.js';
import { calcIndicators } from '../engine/indicator.js';
import { lastSnapshot, setDetail, isTradingTime } from '../service/poller.js';
import { query, esc } from '../db/sqlite.js';
import {
  fetchBoardStocks,
  fetchBoardQuotes,
  type BoardKind,
} from '../sources/tencentBoard.js';
import { boardBars } from '../service/boardIndex.js';
import {
  boardsOfStock,
  ensureBoardIndex,
  boardIndexCount,
  boardSyncState,
} from '../service/boardSync.js';
import { tagsOfStock, emTagSyncState } from '../service/emTagSync.js';
import { marketRows, isMarketKey, MARKETS } from '../service/marketList.js';
import { MAX_BARS, FULL_HISTORY } from '../config.js';
import type { IndicatorSeries, Bar } from '../types.js';

function parseSymbols(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => toSymbol(s))
    .filter(Boolean)
    .slice(0, 200);
}

export async function apiRoutes(app: FastifyInstance) {
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

  app.get('/api/quote', async (req) => {
    const { symbols } = req.query as { symbols?: string };
    const list = parseSymbols(symbols);
    if (!list.length) return { quotes: [], stale: false };
    return getQuotes(list);
  });

  app.get('/api/kline', async (req, reply) => {
    const { symbol, period = 'day', limit = '400', all } = req.query as Record<string, string>;
    const sym = toSymbol(symbol ?? '');
    if (!sym || sym.length < 8) {
      reply.code(400);
      return { error: '缺少 symbol' };
    }
    // limit=all 或 limit=0 → 取上市以来全部
    const wantAll = all === '1' || limit === 'all' || Number(limit) === 0;
    const n = wantAll
      ? 0
      : Math.min(MAX_BARS, Math.max(10, Number(limit) || 400));

    if (period === 'day') {
      const bars = await dailyBars(sym, n);
      return { symbol: sym, period, bars };
    }

    if (period === 'week' || period === 'month') {
      const bars = await fetchFullOrFallback(sym, period, n);
      // 周/月线的均线、MACD 必须按自身周期算，不能套日线指标（索引会错位）
      return { symbol: sym, period, bars, series: bars.length ? calcIndicators(bars) : null };
    }

    const minutes = Number(period.replace('m', '')) || 1;

    // 分钟 K：优先取新浪历史分钟线（最多 1023 根），失败再退回当日分时聚合
    if (minutes >= 5) {
      try {
        const bars = await fetchMinuteKline(sym, minutes, n || 1023);
        if (bars.length) {
          return {
            symbol: sym,
            period,
            date: bars[bars.length - 1].date,
            bars,
            series: calcIndicators(bars),
          };
        }
      } catch {
        /* 落到下面的本地聚合 */
      }
    }

    const { date, points } = await fetchMinute(sym);
    const bars = aggregateMinute(points, minutes, date);
    return {
      symbol: sym,
      period,
      date,
      bars,
      series: bars.length ? calcIndicators(bars) : null,
    };
  });

  app.get('/api/minute', async (req, reply) => {
    const { symbol } = req.query as { symbol?: string };
    const sym = toSymbol(symbol ?? '');
    if (!sym || sym.length < 8) {
      reply.code(400);
      return { error: '缺少 symbol' };
    }
    const { date, points } = await fetchMinute(sym);
    const prevClose = await prevCloseOf(sym);
    return { symbol: sym, date, prevClose, points };
  });

  app.get('/api/indicators', async (req) => {
    const { symbol, limit = '400', all } = req.query as Record<string, string>;
    const sym = toSymbol(symbol ?? '');
    const wantAll = all === '1' || limit === 'all' || Number(limit) === 0;
    const n = wantAll ? 0 : Math.min(MAX_BARS, Math.max(10, Number(limit) || 400));
    const rows = await getIndicators(sym, n);
    if (!rows.length) {
      const bars = await getDailyBars(sym, n);
      if (!bars.length) return { symbol: sym, series: null };
      return { symbol: sym, series: calcIndicators(bars) };
    }
    return { symbol: sym, series: toSeries(rows.reverse()) };
  });

  app.get('/api/watchlist', async () => {
    const items = await listWatchlist();
    const snap = new Map(lastSnapshot().map((q) => [q.symbol, q]));
    return {
      items: items.map((it) => ({ ...it, quote: snap.get(it.symbol) ?? null })),
    };
  });

  app.post('/api/watchlist', async (req, reply) => {
    const body = req.body as { symbol?: string; name?: string };
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
    await addWatch(sym, name);
    return { ok: true, symbol: sym, name };
  });

  app.delete('/api/watchlist/:symbol', async (req) => {
    const { symbol } = req.params as { symbol: string };
    await removeWatch(toSymbol(symbol));
    return { ok: true };
  });

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
    const rows = await query<{ symbol: string; code: string; name: string }>(
      `SELECT symbol, code, name FROM stock
       WHERE symbol LIKE '%${safe}%' OR code LIKE '%${safe}%' OR name LIKE '%${safe}%'
       ORDER BY symbol LIMIT 20`,
    );
    return { items: rows };
  });

  app.post('/api/detail', async (req) => {
    const b = req.body as { symbol?: string };
    setDetail(b?.symbol ? toSymbol(b.symbol) : null);
    return { ok: true };
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

async function prevCloseOf(symbol: string): Promise<number> {
  const bars = await getDailyBars(symbol, 2);
  if (bars.length >= 2) return bars[bars.length - 2].close;
  return bars[0]?.close ?? 0;
}

/**
 * 周/月 K 的取数：腾讯前复权翻页抓全量（东财 push2his 目前被 WAF 拦成空 body，
 * 只做第二顺位），n > 0 时只裁最近 n 根。
 */
async function fetchFullOrFallback(
  symbol: string,
  period: 'day' | 'week' | 'month',
  n: number,
): Promise<Bar[]> {
  const want = n > 0 ? n : FULL_HISTORY;
  try {
    const bars = await fetchKlineDeep(symbol, period, want);
    if (bars.length) return bars;
  } catch {
    /* 落到东财 */
  }
  try {
    const bars = await fetchKlineFull(symbol, period, want);
    if (bars.length) return bars;
  } catch {
    /* 都拿不到就交给前端显示暂无数据 */
  }
  return [];
}

/** 按日期合并两组 K 线，后者覆盖前者 */
function mergeBars(base: Bar[], add: Bar[]): Bar[] {
  const map = new Map<string, Bar>();
  for (const b of base) map.set(b.date, b);
  for (const b of add) map.set(b.date, b);
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 同一日期上收盘价差异超过 0.5%，说明上游对这一段做过前复权重算 */
function qfqDrifted(cached: Bar[], tail: Bar[]): boolean {
  const byDate = new Map(cached.map((b) => [b.date, b]));
  for (const t of tail) {
    const c = byDate.get(t.date);
    if (!c || !(t.close > 0)) continue;
    if (Math.abs(c.close - t.close) > t.close * 0.005) return true;
  }
  return false;
}

/**
 * 日 K 取数：库里已有的历史直接用，每次只回源补最新一页（640 根），
 * 所以从列表页点进一只没缓存过的票只会多花一页的请求；历史不全时才翻页抓全量。
 */
async function dailyBars(symbol: string, n: number): Promise<Bar[]> {
  const wantAll = n <= 0;
  const cached = await getDailyBars(symbol, n);

  if (!cached.length) {
    // 第一次打开这只票：翻页抓全量并落库，下次秒开
    const deep = await fetchKlineDeep(symbol, 'day', wantAll ? FULL_HISTORY : n).catch(
      () => [] as Bar[],
    );
    if (deep.length) await upsertDailyBars(symbol, deep).catch(() => undefined);
    return deep;
  }

  const tail = await fetchKline(symbol, 'day', KLINE_PAGE).catch(() => [] as Bar[]);

  // 上游除权重算过前复权价：老缓存与新价对不上，整段重抓，避免图中间出现跳空
  if (tail.length && qfqDrifted(cached, tail)) {
    await query(`DELETE FROM daily_bar WHERE symbol = ${esc(symbol)}`).catch(() => undefined);
    await query(`DELETE FROM indicator_daily WHERE symbol = ${esc(symbol)}`).catch(() => undefined);
    const deep = await fetchKlineDeep(symbol, 'day', wantAll ? FULL_HISTORY : Math.max(n, KLINE_PAGE)).catch(
      () => [] as Bar[],
    );
    const bars = deep.length ? deep : tail;
    await upsertDailyBars(symbol, bars).catch(() => undefined);
    return wantAll ? bars : bars.slice(-n);
  }

  // 上游挂了就用手里的缓存，不算失败
  if (!tail.length) return wantAll ? cached : cached.slice(-n);

  const merged = mergeBars(cached, tail);
  if (merged.length !== cached.length) void upsertDailyBars(symbol, tail).catch(() => undefined);
  return wantAll ? merged : merged.slice(-n);
}

/** 日线合并成周/月线：首日开、末日收、最高最低取极值、量累加 */
function resample(bars: Bar[], period: 'week' | 'month'): Bar[] {
  const keyOf = (d: string) => {
    if (period === 'month') return d.slice(0, 7);
    const [y, m, dd] = d.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, dd));
    const wd = t.getUTCDay() || 7; // 周一=1 … 周日=7
    t.setUTCDate(t.getUTCDate() - (wd - 1));
    return t.toISOString().slice(0, 10);
  };
  const out: Bar[] = [];
  let key = '';
  let cur: Bar | null = null;
  for (const b of bars) {
    const k = keyOf(b.date);
    if (k !== key) {
      if (cur) out.push(cur);
      cur = { ...b };
      key = k;
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      cur.date = b.date;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function toSeries(rows: Record<string, unknown>[]): IndicatorSeries {  const n = (v: unknown) => {
    const x = Number(v);
    return v === null || v === undefined || !Number.isFinite(x) ? NaN : x;
  };
  const pick = (k: string) => rows.map((r) => n(r[k]));
  return {
    date: rows.map((r) => String(r.date)),
    ma5: pick('ma5'),
    ma10: pick('ma10'),
    ma20: pick('ma20'),
    ma60: pick('ma60'),
    bollUp: pick('boll_up'),
    bollMid: pick('boll_mid'),
    bollDn: pick('boll_dn'),
    macdDif: pick('macd_dif'),
    macdDea: pick('macd_dea'),
    macdHist: pick('macd_hist'),
    kdjK: pick('kdj_k'),
    kdjD: pick('kdj_d'),
    kdjJ: pick('kdj_j'),
    rsi6: pick('rsi6'),
    rsi12: pick('rsi12'),
    atr14: pick('atr14'),
    obv: pick('obv'),
  };
}
