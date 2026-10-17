import type { StockInfo, Quote, Bar } from '../types.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let lastGood: Quote[] = [];
let lastGoodAt = 0;

interface SinaRow {
  symbol: string;
  code: string;
  name: string;
  trade: string;
  pricechange: string;
  changepercent: string;
  buy: string;
  sell: string;
  settlement: string;
  open: string;
  high: string;
  low: string;
  volume: number;
  amount: number;
  ticktime: string;
  per: number;
  pb: number;
  mktcap: number;
  nmc: number;
  turnoverratio: number;
}

function numOf(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toQuote(r: SinaRow): Quote {
  const price = numOf(r.trade);
  const prevClose = numOf(r.settlement);
  const change = numOf(r.pricechange);
  return {
    symbol: r.symbol,
    name: r.name ?? '',
    code: r.code ?? r.symbol.slice(2),
    price,
    prevClose,
    open: numOf(r.open),
    high: numOf(r.high),
    low: numOf(r.low),
    change,
    changePct: numOf(r.changepercent),
    volume: numOf(r.volume) / 100,
    amount: numOf(r.amount),
    turnoverRate: numOf(r.turnoverratio),
    pe: numOf(r.per) || null,
    pb: numOf(r.pb) || null,
    amplitude: prevClose > 0 ? ((numOf(r.high) - numOf(r.low)) / prevClose) * 100 : 0,
    marketCap: numOf(r.mktcap) * 1e4,
    floatCap: numOf(r.nmc) * 1e4,
    volumeRatio: 0,
    avgPrice: price,
    limitUp: 0,
    limitDown: 0,
    bids: [
      { price: numOf(r.buy), volume: 0 },
    ],
    asks: [
      { price: numOf(r.sell), volume: 0 },
    ],
    time: r.ticktime ?? '',
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error('空响应');
  return JSON.parse(text) as T;
}

/** 拉取全市场 A 股快照（约 56 页 × 100 只） */
export async function fetchAllMarket(pageSize = 100, maxPages = 80): Promise<Quote[]> {
  const all: Quote[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url =
      'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
      `?page=${page}&num=${pageSize}&sort=symbol&asc=1&node=hs_a`;
    let rows: SinaRow[];
    try {
      rows = await getJson<SinaRow[]>(url);
    } catch (e) {
      if (all.length === 0) throw e;
      break;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const q = toQuote(r);
      if (q.price > 0) all.push(q);
    }
    if (rows.length < pageSize) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  if (all.length > 0) {
    lastGood = all;
    lastGoodAt = Date.now();
  }
  return all;
}

export function lastMarketCache(): { quotes: Quote[]; at: number } {
  return { quotes: lastGood, at: lastGoodAt };
}

export async function fetchStocks(): Promise<StockInfo[]> {
  const quotes = await fetchAllMarket();
  return quotes.map((q) => ({
    symbol: q.symbol,
    code: q.code,
    name: q.name,
    market: q.symbol.slice(0, 2).toUpperCase(),
  }));
}

interface SinaKlineRow {
  day: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount?: string;
}

/** 分钟 K 内存缓存：同周期 45 秒内复用，避免来回切周期时重复打源站 */
const minuteKlineCache = new Map<string, { at: number; bars: Bar[] }>();
const MINUTE_KLINE_TTL = 45_000;

/**
 * 拉取历史分钟 K（新浪）。
 * scale 支持 5/15/30/60，datalen 上限 1023 根。
 * 返回的 day 是**该根 K 线的结束时间**（如 5 分钟首根为 09:35），与同花顺口径一致。
 * volume 源站单位是股，这里统一折成手，与全站一致。
 */
export async function fetchMinuteKline(
  symbol: string,
  scale: number,
  datalen = 1023,
): Promise<Bar[]> {
  const key = `${symbol}:${scale}`;
  const hit = minuteKlineCache.get(key);
  if (hit && Date.now() - hit.at < MINUTE_KLINE_TTL) return hit.bars;

  const url =
    'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData' +
    `?symbol=${symbol}&scale=${scale}&ma=no&datalen=${datalen}`;
  const rows = await getJson<SinaKlineRow[]>(url);
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const bars: Bar[] = [];
  for (const r of rows) {
    const open = numOf(r.open);
    const close = numOf(r.close);
    if (!(open > 0) || !(close > 0)) continue;
    const day = String(r.day ?? '').trim();
    if (!day) continue;
    bars.push({
      // 只保留到分钟，去掉秒
      date: day.length > 16 ? day.slice(0, 16) : day,
      open,
      high: numOf(r.high),
      low: numOf(r.low),
      close,
      volume: numOf(r.volume) / 100,
    });
  }

  // 时间戳去重并保持升序，lightweight-charts 要求严格递增
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dedup: Bar[] = [];
  for (const b of bars) {
    if (dedup.length && dedup[dedup.length - 1].date === b.date) dedup[dedup.length - 1] = b;
    else dedup.push(b);
  }

  if (dedup.length) minuteKlineCache.set(key, { at: Date.now(), bars: dedup });
  return dedup;
}
