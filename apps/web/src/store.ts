import { create } from 'zustand';
import type { Quote, WatchItem } from './api';

interface State {
  items: WatchItem[];
  quotes: Record<string, Quote>;
  selected: string;
  period: string;
  stale: boolean;
  connected: boolean;
  lastTs: number;
  setItems: (items: WatchItem[]) => void;
  mergeQuotes: (quotes: Quote[], stale?: boolean) => void;
  select: (symbol: string) => void;
  setPeriod: (p: string) => void;
  setConnected: (v: boolean) => void;
}

export const useStore = create<State>((set) => ({
  items: [],
  quotes: {},
  selected: '',
  period: 'day',
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
  setConnected: (connected) => set({ connected }),
}));
