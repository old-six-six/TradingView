import { create } from 'zustand';
import type { Quote, WatchItem } from './api';

/** 列表页的汇总信息，由 MarketPage 上报、状态栏展示 */
export interface MarketStat {
  key: string;
  label: string;
  count: number;
  up: number;
  down: number;
  updatedAt: number;
  loading: boolean;
}

const SIDEBAR_KEY = 'tv.sidebar';

/** 左侧自选是否展开，刷新后保持 */
function loadSidebar(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== '0';
  } catch {
    return true;
  }
}

interface State {
  items: WatchItem[];
  quotes: Record<string, Quote>;
  selected: string;
  period: string;
  /** 全市场列表页：null 表示看图表 */
  market: string | null;
  marketStat: MarketStat | null;
  /** 左侧自选栏是否展开 */
  sidebar: boolean;
  toggleSidebar: () => void;
  stale: boolean;
  connected: boolean;
  lastTs: number;
  setItems: (items: WatchItem[]) => void;
  mergeQuotes: (quotes: Quote[], stale?: boolean) => void;
  select: (symbol: string) => void;
  setPeriod: (p: string) => void;
  setMarket: (m: string | null) => void;
  setMarketStat: (s: MarketStat | null) => void;
  setConnected: (v: boolean) => void;
}

export const useStore = create<State>((set) => ({
  items: [],
  quotes: {},
  selected: '',
  period: 'day',
  market: null,
  marketStat: null,
  sidebar: loadSidebar(),
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebar;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      } catch {
        /* 忽略隐私模式下的写入失败 */
      }
      return { sidebar: next };
    }),
  stale: false,
  connected: false,
  lastTs: 0,
  setItems: (items) =>
    set((s) => ({ items, selected: s.selected || items[0]?.symbol || '' })),
  mergeQuotes: (quotes, stale) =>
    set((s) => {
      const next = { ...s.quotes };
      for (const q of quotes) next[q.symbol] = q;
      return { quotes: next, stale: stale ?? s.stale, lastTs: Date.now() };
    }),
  select: (symbol) => set({ selected: symbol }),
  setPeriod: (period) => set({ period }),
  setMarket: (market) => set({ market }),
  setMarketStat: (marketStat) => set({ marketStat }),
  setConnected: (connected) => set({ connected }),
}));
