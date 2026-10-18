import { fetchKline, fetchKlineDeep, KLINE_PAGE } from '../sources/tencent.js';
import { fetchKlineFull } from '../sources/eastmoney.js';
import { getDailyBars, upsertDailyBars, upsertIndicators } from '../db/repo.js';
import { calcIndicators } from '../engine/indicator.js';
import { exec } from '../db/sqlite.js';
import { FULL_HISTORY } from '../config.js';
import type { Bar, IndicatorSeries } from '../types.js';

/**
 * 日 K 的取数、落库与派生计算都集中在这里。
 *
 * 之前同一套「缓存优先 + 回源补尾 + 前复权漂移重抓」在 routes/api.ts 和
 * service/sync.ts 各写了一遍，改一处忘一处就会出现「图上是新价、库里是旧价」。
 */

/** 按日期合并两组 K 线，后者覆盖前者 */
export function mergeBars(base: Bar[], add: Bar[]): Bar[] {
  const map = new Map<string, Bar>();
  for (const b of base) map.set(b.date, b);
  for (const b of add) map.set(b.date, b);
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 同一日期上收盘价差异超过 0.5%，说明上游对这一段做过前复权重算 */
export function qfqDrifted(cached: Bar[], tail: Bar[]): boolean {
  const byDate = new Map(cached.map((b) => [b.date, b]));
  for (const t of tail) {
    const c = byDate.get(t.date);
    if (!c || !(t.close > 0)) continue;
    if (Math.abs(c.close - t.close) > t.close * 0.005) return true;
  }
  return false;
}

/** 日线合并成周/月线：首日开、末日收、最高最低取极值、量累加 */
export function resample(bars: Bar[], period: 'week' | 'month'): Bar[] {
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

/** 数据库行 → 指标序列（列名是下划线，前端用驼峰） */
export function toSeries(rows: Record<string, unknown>[]): IndicatorSeries {
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

/** 昨收（用于分时基准线）：取库里倒数第二根日 K */
export async function prevCloseOf(symbol: string): Promise<number> {
  const bars = await getDailyBars(symbol, 2);
  if (bars.length >= 2) return bars[bars.length - 2].close;
  return bars[0]?.close ?? 0;
}

/**
 * 日 K 取数：库里已有的历史直接用，每次只回源补最新一页（640 根），
 * 所以从列表页点进一只没缓存过的票只会多花一页的请求；历史不全时才翻页抓全量。
 */
export async function loadDailyBars(symbol: string, n: number): Promise<Bar[]> {
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
    await exec(`DELETE FROM daily_bar WHERE symbol = '${symbol.replace(/'/g, "''")}'`).catch(
      () => undefined,
    );
    await exec(`DELETE FROM indicator_daily WHERE symbol = '${symbol.replace(/'/g, "''")}'`).catch(
      () => undefined,
    );
    const deep = await fetchKlineDeep(
      symbol,
      'day',
      wantAll ? FULL_HISTORY : Math.max(n, KLINE_PAGE),
    ).catch(() => [] as Bar[]);
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

/**
 * 周/月 K 的取数：腾讯前复权翻页抓全量（东财 push2his 目前被 WAF 拦成空 body，
 * 只做第二顺位），n > 0 时只裁最近 n 根。
 */
export async function fetchPeriodBars(
  symbol: string,
  period: 'week' | 'month',
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

export interface DailyRefresh {  symbol: string;
  bars: number;
  source: 'tencent' | 'eastmoney';
  /** 本次是否重算了指标（回填大批量时可关掉，图表会按需现算） */
  indicators: boolean;
}

/**
 * 单只票的日 K 全量刷新（自选同步、手动回填都走这里）。
 *
 * 库里没有历史时抓「上市以来全部」，已有历史只补最近一页；腾讯失败退东财。
 * 与 loadDailyBars 的区别：这个会等指标重算完成再返回，给后台任务用。
 */
export async function refreshDailyBars(
  symbol: string,
  opts: { count?: number; indicators?: boolean } = {},
): Promise<DailyRefresh> {
  const count = opts.count ?? 640;
  const stored = await getDailyBars(symbol, 0);
  let bars: Bar[] = [];
  let source: 'tencent' | 'eastmoney' = 'tencent';

  try {
    bars = stored.length
      ? await fetchKline(symbol, 'day', Math.max(count, KLINE_PAGE))
      : await fetchKlineDeep(symbol, 'day', FULL_HISTORY);
  } catch (e) {
    source = 'eastmoney';
    try {
      bars = await fetchKlineFull(symbol, 'day', FULL_HISTORY);
    } catch {
      throw new Error(`行情源均失败：${(e as Error).message}`);
    }
  }
  if (!bars.length) return { symbol, bars: 0, source, indicators: false };

  await upsertDailyBars(symbol, bars);

  if (opts.indicators === false) return { symbol, bars: bars.length, source, indicators: false };

  // 指标按库里全部历史重算，均线/MACD 的起始段才正确
  const all = await getDailyBars(symbol, 0);
  await upsertIndicators(symbol, calcIndicators(all));
  return { symbol, bars: bars.length, source, indicators: true };
}
