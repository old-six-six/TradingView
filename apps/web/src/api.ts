export interface Level {
  price: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  name: string;
  code: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePct: number;
  volume: number;
  amount: number;
  turnoverRate: number;
  pe: number | null;
  pb: number | null;
  amplitude: number;
  marketCap: number;
  floatCap: number;
  volumeRatio: number;
  avgPrice: number;
  limitUp: number;
  limitDown: number;
  bids: Level[];
  asks: Level[];
  time: string;
}

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MinutePoint {
  time: string;
  price: number;
  volume: number;
  amount: number;
}

export interface IndicatorSeries {
  date: string[];
  ma5: number[];
  ma10: number[];
  ma20: number[];
  ma60: number[];
  bollUp: number[];
  bollMid: number[];
  bollDn: number[];
  macdDif: number[];
  macdDea: number[];
  macdHist: number[];
  kdjK: number[];
  kdjD: number[];
  kdjJ: number[];
  rsi6: number[];
  rsi12: number[];
  atr14: number[];
  obv: number[];
}

export interface WatchItem {
  symbol: string;
  name: string;
  grp: string;
  sort_order: number;
  quote?: Quote | null;
}

/** 板块类型：行业 / 概念 / 地域 */
export type BoardKind = 'hy' | 'gn' | 'dy';

export interface StockBoard {
  code: string;
  name: string;
  kind: BoardKind;
  changePct: number;
  price: number;
}

export interface BoardStock {
  symbol: string;
  code: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  amount: number;
  turnoverRate: number;
  volumeRatio: number;
  amplitude: number;
  marketCap: number;
  floatCap: number;
  pe: number | null;
  pb: number | null;
}

/** 全市场列表行，字段见 service/marketList.ts */
export interface MarketRow {
  symbol: string;
  code: string;
  name: string;
  price: number;
  changePct: number;
  change: number;
  turnoverRate: number;
  volumeRatio: number;
  speed: number | null;
  amount: number;
  volume: number;
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

const BASE = '';

async function get<T>(url: string): Promise<T> {
  const res = await fetch(BASE + url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  health: () => get<Record<string, unknown>>('/api/health'),
  quote: (symbols: string[]) =>
    get<{ quotes: Quote[]; stale: boolean }>(`/api/quote?symbols=${symbols.join(',')}`),
  kline: (symbol: string, period: string, limit: number | 'all' = 400) =>
    get<{
      symbol: string;
      period: string;
      date?: string;
      bars: Bar[];
      series?: IndicatorSeries | null;
    }>(`/api/kline?symbol=${symbol}&period=${period}&limit=${limit}`),
  minute: (symbol: string) =>
    get<{ symbol: string; date: string; prevClose: number; points: MinutePoint[] }>(
      `/api/minute?symbol=${symbol}`,
    ),
  indicators: (symbol: string, limit: number | 'all' = 400) =>
    get<{ symbol: string; series: IndicatorSeries | null }>(
      `/api/indicators?symbol=${symbol}&limit=${limit}`,
    ),
  watchlist: () => get<{ items: WatchItem[] }>('/api/watchlist'),
  addWatch: (symbol: string, name?: string) =>
    fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, name }),
    }).then((r) => r.json()),
  removeWatch: (symbol: string) =>
    fetch(`/api/watchlist/${symbol}`, { method: 'DELETE' }).then((r) => r.json()),
  positions: () => get<{ items: any[] }>('/api/positions'),
  search: (q: string) =>
    get<{ items: Array<{ symbol: string; code: string; name: string }> }>(
      `/api/search?q=${encodeURIComponent(q)}`,
    ),
  detail: (symbol: string | null) =>
    fetch('/api/detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
    }).then((r) => r.json()),
  stockBoards: (symbol: string) =>
    get<{
      symbol: string;
      ready: boolean;
      boards: StockBoard[];
      /** 东财有、腾讯没有同名板块的标签（科创板/北交所），只展示不可点 */
      tags?: string[];
      sync?: { running: boolean; done: number; total: number };
    }>(`/api/stock/boards?symbol=${symbol}`),
  boardKline: (code: string, period = 'day', limit = 400) =>
    get<{
      code: string;
      name: string;
      kind: BoardKind;
      period: string;
      bars: Bar[];
      series: IndicatorSeries | null;
    }>(`/api/board/kline?code=${code}&period=${period}&limit=${limit}`),
  boardStocks: (code: string, kind?: BoardKind) =>
    get<{ code: string; name: string; kind: BoardKind; items: BoardStock[] }>(
      `/api/board/stocks?code=${code}${kind ? `&kind=${kind}` : ''}`,
    ),
  marketList: (board: string) =>
    get<{
      board: string;
      label: string;
      updatedAt: number;
      cached: boolean;
      rows: MarketRow[];
    }>(`/api/market/list?board=${board}`),
  /** 板块成员名单（按代码升序），键盘在板块内翻票用 */
  marketUniverse: (board: string) =>
    get<{
      board: string;
      cached: boolean;
      rows: Array<{ symbol: string; code: string; name: string }>;
    }>(`/api/market/universe?board=${board}`),
};
