import { query } from '../db/sqlite.js';
import { fetchSnapshots, type Snapshot } from '../sources/tencent.js';

/** 五个可点开的市场板块 */
export type MarketKey = 'sh_main' | 'sz_main' | 'cyb' | 'kcb' | 'bj';

export const MARKETS: Record<MarketKey, { label: string; where: string }> = {
  sh_main: { label: '上证主板', where: "symbol LIKE 'sh60%'" },
  sz_main: { label: '深证主板', where: "symbol LIKE 'sz00%'" },
  cyb: { label: '创业板', where: "symbol LIKE 'sz30%'" },
  kcb: { label: '科创板', where: "symbol LIKE 'sh68%'" },
  bj: { label: '北交所', where: "symbol LIKE 'bj%'" },
};

export function isMarketKey(v: string): v is MarketKey {
  return Object.prototype.hasOwnProperty.call(MARKETS, v);
}

export interface MarketRow {
  symbol: string;
  code: string;
  name: string;
  price: number;
  changePct: number;
  change: number;
  turnoverRate: number;
  volumeRatio: number;
  /** 5 分钟涨速（%），样本不足时为 null */
  speed: number | null;
  amount: number;
  /** 总手 */
  volume: number;
  /** 现手：距上次快照新增的成交量（手） */
  nowVolume: number;
  high: number;
  low: number;
  industry: string;
  pe: number | null;
  peDyn: number | null;
  pb: number | null;
  floatCap: number;
  marketCap: number;
  outer: number;
  inner: number;
  prevClose: number;
  open: number;
  bidPrice: number;
  askPrice: number;
  avgPrice: number;
  weibi: number;
  weicha: number;
  time: string;
}

interface Universe {
  symbol: string;
  code: string;
  name: string;
}

const UNIVERSE_TTL = 10 * 60 * 1000;
const CACHE_TTL = 2500;

const universeCache = new Map<MarketKey, { at: number; list: Universe[] }>();
let industryCache: { at: number; map: Map<string, string> } | null = null;

/** 每只票最近的快照样本，用于算 5 分钟涨速 */
const samples = new Map<string, Array<{ ts: number; px: number }>>();
/** 上次成交量，用于算现手 */
const lastVol = new Map<string, { ts: number; vol: number }>();

const SAMPLE_GAP = 25_000;
const SAMPLE_KEEP = 6 * 60 * 1000;

async function universeOf(key: MarketKey): Promise<Universe[]> {
  const hit = universeCache.get(key);
  if (hit && Date.now() - hit.at < UNIVERSE_TTL) return hit.list;
  const rows = await query<{ symbol: string; code: string; name: string }>(
    `SELECT symbol, code, name FROM stock WHERE ${MARKETS[key].where} ORDER BY code`,
  );
  const list = rows.map((r) => ({
    symbol: String(r.symbol),
    code: String(r.code ?? String(r.symbol).slice(2)),
    name: String(r.name ?? ''),
  }));
  universeCache.set(key, { at: Date.now(), list });
  return list;
}

/** 行业取「所属行业」板块名，一个票可能挂在多个行业下，取第一个 */
async function industryMap(): Promise<Map<string, string>> {
  if (industryCache && Date.now() - industryCache.at < UNIVERSE_TTL) return industryCache.map;
  const rows = await query<{ symbol: string; name: string }>(
    `SELECT m.symbol AS symbol, b.name AS name
       FROM board_member m JOIN board b ON b.code = m.board_code
      WHERE b.kind = 'hy'
      ORDER BY b.name`,
  );
  const map = new Map<string, string>();
  for (const r of rows) {
    if (!map.has(String(r.symbol))) map.set(String(r.symbol), String(r.name));
  }
  industryCache = { at: Date.now(), map };
  return map;
}

/** 5 分钟涨速：取 4–6 分钟前的样本做基准，样本不足时退化为能取到的最早一条 */
function pushSample(symbol: string, price: number, now: number): number | null {
  let arr = samples.get(symbol);
  if (!arr) {
    arr = [];
    samples.set(symbol, arr);
  }
  const last = arr[arr.length - 1];
  if (!last || now - last.ts >= SAMPLE_GAP) arr.push({ ts: now, px: price });
  else {
    last.px = price;
    last.ts = now;
  }
  while (arr.length > 1 && now - arr[0].ts > SAMPLE_KEEP) arr.shift();

  const base = arr.find((s) => now - s.ts >= 240_000);
  if (base && base.px > 0 && now - base.ts <= SAMPLE_KEEP) {
    return ((price - base.px) / base.px) * 100;
  }
  const oldest = arr[0];
  if (oldest && oldest.ts !== now && now - oldest.ts >= 60_000 && oldest.px > 0) {
    return ((price - oldest.px) / oldest.px) * 100;
  }
  return null;
}

/** 现手：距上次快照新增的量，间隔过久（>30s）视为无意义 */
function takeNowVolume(symbol: string, volume: number, now: number): number {
  const prev = lastVol.get(symbol);
  lastVol.set(symbol, { ts: now, vol: volume });
  if (!prev || now - prev.ts > 30_000) return 0;
  const diff = volume - prev.vol;
  return diff > 0 ? diff : 0;
}

function bidAsk(s: Snapshot): { bid: number; ask: number } {
  return { bid: s.bids[0]?.price ?? 0, ask: s.asks[0]?.price ?? 0 };
}

function emptyRow(u: Universe, industry: string): MarketRow {
  return {
    symbol: u.symbol,
    code: u.code,
    name: u.name,
    price: 0,
    changePct: 0,
    change: 0,
    turnoverRate: 0,
    volumeRatio: 0,
    speed: null,
    amount: 0,
    volume: 0,
    nowVolume: 0,
    high: 0,
    low: 0,
    industry,
    pe: null,
    peDyn: null,
    pb: null,
    floatCap: 0,
    marketCap: 0,
    outer: 0,
    inner: 0,
    prevClose: 0,
    open: 0,
    bidPrice: 0,
    askPrice: 0,
    avgPrice: 0,
    weibi: 0,
    weicha: 0,
    time: '',
  };
}

async function refresh(key: MarketKey): Promise<MarketRow[]> {
  const [universe, industry] = await Promise.all([universeOf(key), industryMap()]);
  const snaps = await fetchSnapshots(universe.map((u) => u.symbol));
  const bySymbol = new Map(snaps.map((s) => [s.symbol, s]));
  const now = Date.now();
  const out: MarketRow[] = [];

  for (const u of universe) {
    const s = bySymbol.get(u.symbol);
    if (!s) {
      out.push(emptyRow(u, industry.get(u.symbol) ?? ''));
      continue;
    }
    const { bid, ask } = bidAsk(s);
    const volSum = s.bidVolume + s.askVolume;
    out.push({
      symbol: s.symbol,
      code: s.code,
      name: s.name || u.name,
      price: s.price,
      changePct: s.changePct,
      change: s.change,
      turnoverRate: s.turnoverRate,
      volumeRatio: s.volumeRatio,
      speed: pushSample(s.symbol, s.price, now),
      amount: s.amount,
      volume: s.volume,
      nowVolume: takeNowVolume(s.symbol, s.volume, now),
      high: s.high,
      low: s.low,
      industry: industry.get(s.symbol) ?? '',
      pe: s.pe,
      peDyn: s.peDyn,
      pb: s.pb,
      floatCap: s.floatCap,
      marketCap: s.marketCap,
      outer: s.outerVolume,
      inner: s.innerVolume,
      prevClose: s.prevClose,
      open: s.open,
      bidPrice: bid,
      askPrice: ask,
      avgPrice: s.avgPrice,
      weibi: volSum > 0 ? (s.weicha / volSum) * 100 : 0,
      weicha: s.weicha,
      time: s.time,
    });
  }

  out.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return out;
}

/**
 * 某个市场的全部成员（只含 symbol/code/name，按代码升序）。
 * 给「键盘在板块内逐个翻票」用：全量快照接口要拉上千只的实时行情，
 * 体量几百 KB 且要几秒，翻页根本用不着，这里只读库里的名单。
 */
export async function marketUniverse(
  key: MarketKey,
): Promise<{ rows: Universe[]; cached: boolean }> {
  const hit = universeCache.get(key);
  if (hit && Date.now() - hit.at < UNIVERSE_TTL) return { rows: hit.list, cached: true };
  return { rows: await universeOf(key), cached: false };
}

const cache = new Map<MarketKey, { at: number; rows: MarketRow[] }>();
const inflight = new Map<MarketKey, Promise<MarketRow[]>>();

/**
 * 某个市场的全量快照。TTL 内的请求共用同一份缓存，
 * 并发请求共用同一个 in-flight 任务，避免打爆上游。
 */
export async function marketRows(
  key: MarketKey,
): Promise<{ rows: MarketRow[]; at: number; cached: boolean }> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return { rows: hit.rows, at: hit.at, cached: true };
  }
  let task = inflight.get(key);
  if (!task) {
    task = refresh(key)
      .then((rows) => {
        cache.set(key, { at: Date.now(), rows });
        return rows;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, task);
  }
  const rows = await task;
  return { rows, at: cache.get(key)?.at ?? Date.now(), cached: false };
}

/** 清理长时间没被访问的样本，避免常驻内存膨胀 */
export function pruneSamples(): void {
  const now = Date.now();
  for (const [sym, arr] of samples) {
    if (!arr.length || now - arr[arr.length - 1].ts > SAMPLE_KEEP * 2) samples.delete(sym);
  }
  for (const [sym, v] of lastVol) {
    if (now - v.ts > SAMPLE_KEEP * 2) lastVol.delete(sym);
  }
}
