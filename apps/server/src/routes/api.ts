import type { FastifyInstance } from 'fastify';
import { getQuotes, sourceHealth, isCircuitOpen } from '../sources/gateway.js';
import { toSymbol, fetchMinute, fetchKline } from '../sources/tencent.js';
import { lastMarketCache, fetchAllMarket, fetchMinuteKline } from '../sources/sina.js';
import {
  getDailyBars,
  getIndicators,
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
import { query } from '../db/sqlite.js';
import type { IndicatorSeries } from '../types.js';

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
    const { symbol, period = 'day', limit = '400' } = req.query as Record<string, string>;
    const sym = toSymbol(symbol ?? '');
    if (!sym || sym.length < 8) {
      reply.code(400);
      return { error: '缺少 symbol' };
    }
    const n = Math.min(2000, Math.max(10, Number(limit) || 400));

    if (period === 'day') {
      const bars = await getDailyBars(sym, n);
      if (bars.length) return { symbol: sym, period, bars };
      const fetched = await fetchKline(sym, 'day', n);
      return { symbol: sym, period, bars: fetched };
    }

    if (period === 'week' || period === 'month') {
      const bars = await fetchKline(sym, period, n);
      return { symbol: sym, period, bars };
    }

    const minutes = Number(period.replace('m', '')) || 1;

    // 分钟 K：优先取新浪历史分钟线（最多 1023 根），失败再退回当日分时聚合
    if (minutes >= 5) {
      try {
        const bars = await fetchMinuteKline(sym, minutes, n);
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
    const { symbol, limit = '400' } = req.query as Record<string, string>;
    const sym = toSymbol(symbol ?? '');
    const n = Math.min(2000, Math.max(10, Number(limit) || 400));
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
}

async function prevCloseOf(symbol: string): Promise<number> {
  const bars = await getDailyBars(symbol, 2);
  if (bars.length >= 2) return bars[bars.length - 2].close;
  return bars[0]?.close ?? 0;
}

function toSeries(rows: Record<string, unknown>[]): IndicatorSeries {
  const n = (v: unknown) => {
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
