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
  /**
   * 当前这只票是从哪个市场板块点进来的（板块 key）。只有五大 MarketPage
   * 列表点进来才有值，自选 / 板块弹窗 / 【】换股都会清掉。
   */
  entry: string | null;
  /**
   * 「当前位置」板块的成员名单（按代码升序），给 【 】 在板块内逐个翻票用。
   * 从列表页点进来时顺手注入；刷新后没有这份缓存就由 App 去补拉。
   */
  boardMembers: { board: string; symbols: string[] } | null;
  toggleSidebar: () => void;
  stale: boolean;
  connected: boolean;
  lastTs: number;
  setItems: (items: WatchItem[]) => void;
  mergeQuotes: (quotes: Quote[], stale?: boolean) => void;
  select: (symbol: string, fromBoard?: string | null) => void;
  setPeriod: (p: string) => void;
  setMarket: (m: string | null) => void;
  setEntry: (b: string | null) => void;
  setBoardMembers: (m: { board: string; symbols: string[] } | null) => void;
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
  entry: null,
  boardMembers: null,
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
  /**
   * 选票。带第二个参数时同时记下来源板块；不传的话——只要真的换了票就把来源清掉
   * （同一个 symbol 重复 select 常见于初始化和刷新，那不算切换）。
   */
  select: (symbol, fromBoard) =>
    set((s) => ({
      selected: symbol,
      entry: fromBoard !== undefined ? fromBoard : s.selected === symbol ? s.entry : null,
    })),
  setPeriod: (period) => set({ period }),
  setMarket: (market) => set({ market }),
  setEntry: (entry) => set({ entry }),
  setBoardMembers: (boardMembers) => set({ boardMembers }),
  setMarketStat: (marketStat) => set({ marketStat }),
  setConnected: (connected) => set({ connected }),
}));
