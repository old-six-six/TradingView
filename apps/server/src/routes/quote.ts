import type { FastifyInstance } from 'fastify';
import { getQuotes } from '../sources/gateway.js';
import { toSymbol, fetchMinute } from '../sources/tencent.js';
import { fetchMinuteKline } from '../sources/sina.js';
import { getIndicators, getDailyBars } from '../db/repo.js';
import { aggregateMinute } from '../engine/minute-agg.js';
import { calcIndicators } from '../engine/indicator.js';
import { setDetail } from '../service/poller.js';
import { loadDailyBars, fetchPeriodBars, prevCloseOf, toSeries } from '../service/kline.js';
import { MAX_BARS } from '../config.js';

/** 行情与 K 线：实时快照、日线、分钟线、指标、当前详情订阅 */

function parseSymbols(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => toSymbol(s))
    .filter(Boolean)
    .slice(0, 200);
}

/** limit=all / limit=0 → 全部；否则夹在 [10, MAX_BARS] */
function limitOf(limit?: string, all?: string): number {
  const wantAll = all === '1' || limit === 'all' || Number(limit) === 0;
  return wantAll ? 0 : Math.min(MAX_BARS, Math.max(10, Number(limit) || 400));
}

export async function quoteRoutes(app: FastifyInstance) {
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
    const n = limitOf(limit, all);

    if (period === 'day') {
      const bars = await loadDailyBars(sym, n);
      return { symbol: sym, period, bars };
    }

    if (period === 'week' || period === 'month') {
      const bars = await fetchPeriodBars(sym, period, n);
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
    const n = limitOf(limit, all);
    const rows = await getIndicators(sym, n);
    if (rows.length) return { symbol: sym, series: toSeries(rows.reverse()) };
    // 老库可能只存了日 K 没存指标：现算一份返回，不阻塞图表
    const bars = await getDailyBars(sym, n);
    if (!bars.length) return { symbol: sym, series: null };
    return { symbol: sym, series: calcIndicators(bars) };
  });

  /** 订阅当前详情：轮询器按这个 symbol 每秒补一次盘口 */
  app.post('/api/detail', async (req) => {
    const b = req.body as { symbol?: string };
    setDetail(b?.symbol ? toSymbol(b.symbol) : null);
    return { ok: true };
  });
}
