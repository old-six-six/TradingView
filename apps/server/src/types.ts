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

export interface Level {
  price: number;
  volume: number;
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

export interface StockInfo {
  symbol: string;
  code: string;
  name: string;
  market: string;
}

export type Period = 'day' | 'week' | 'month' | 'm1' | 'm5' | 'm15' | 'm30' | 'm60';

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
