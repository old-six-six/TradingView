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
};
