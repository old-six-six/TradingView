import { create } from 'zustand';
import { api, type Quote, type WatchFolder, type WatchItem } from './api';

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

/** 侧边栏与键盘翻票用的精简行：只要展示和排序需要的字段 */
const SIDEBAR_KEY = 'tv.sidebar';
export interface BoardLiteRow {
  symbol: string;
  code: string;
  name: string;
  price: number;
  changePct: number;
}

/** 左侧板块列表的排序方式：按代码升序，或按涨幅从高到低 */
export type SideSort = 'code' | 'pct';

/** 顶栏五大指数弹窗要看的指数：代码、短名、全称、对应板块 key */
export interface IndexRef {
  symbol: string;
  label: string;
  full: string;
  market: string;
}

/** 按指定方式排序：代码升序 / 涨幅从高到低（涨幅榜的惯用方向） */
export function sortBoardRows(rows: BoardLiteRow[], sort: SideSort): BoardLiteRow[] {
  const list = [...rows];
  if (sort === 'pct') list.sort((a, b) => b.changePct - a.changePct);
  else list.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return list;
}

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
  /** 自选文件夹清单（含票数），由 /api/watchlist 一起带回来 */
  folders: WatchFolder[];
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
   * 「当前位置」板块的成员名单（含名称与涨幅），左侧侧边栏和 【 】 都按它走。
   * 从列表页点进来时会带着一份现成的；刷新后由 App 去补拉。
   */
  boardRows: { board: string; rows: BoardLiteRow[]; at: number } | null;
  /** 左侧板块列表的排序方式，默认按代码 */
  sideSort: SideSort;
  /** 顶栏五大指数弹窗当前打开的那只；null 表示没开 */
  indexModal: IndexRef | null;
  /**
   * 从指数弹窗点「成分股」进的列表页时记下弹窗本身。
   * 列表页按 Esc / 返回图表就先把这个弹窗还原，等于原路退回去。
   */
  indexReturn: IndexRef | null;
  toggleSidebar: () => void;
  stale: boolean;
  connected: boolean;
  lastTs: number;
  setItems: (items: WatchItem[]) => void;
  setFolders: (folders: WatchFolder[]) => void;
  /** 重新拉一遍自选与文件夹（增删票、增删文件夹后调用） */
  reloadWatch: () => Promise<void>;
  mergeQuotes: (quotes: Quote[], stale?: boolean) => void;
  select: (symbol: string, fromBoard?: string | null) => void;
  setPeriod: (p: string) => void;
  setMarket: (m: string | null) => void;
  setEntry: (b: string | null) => void;
  setBoardRows: (m: { board: string; rows: BoardLiteRow[]; at: number } | null) => void;
  setSideSort: (s: SideSort) => void;
  setIndexModal: (r: IndexRef | null) => void;
  setIndexReturn: (r: IndexRef | null) => void;
  setMarketStat: (s: MarketStat | null) => void;
  setConnected: (v: boolean) => void;
}

export const useStore = create<State>((set) => ({
  items: [],
  folders: [],
  quotes: {},
  selected: '',
  period: 'day',
  market: null,
  marketStat: null,
  entry: null,
  boardRows: null,
  // 每次打开都回到代码顺序，不记上次的选择
  sideSort: 'code',
  indexModal: null,
  indexReturn: null,
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
  setFolders: (folders) => set({ folders }),
  reloadWatch: async () => {
    const r = await api.watchlist();
    set((s) => {
      const wasInList = s.items.some((it) => it.symbol === s.selected);
      const stillIn = r.items.some((it) => it.symbol === s.selected);
      // 只有「本来在自选里、这次被删掉了」才退回第一只。
      // 搜索结果看的票根本不在自选里，刷一次列表不该把图跳走。
      return {
        items: r.items,
        folders: r.folders ?? [],
        selected: s.selected && (!wasInList || stillIn) ? s.selected : r.items[0]?.symbol || '',
      };
    });
  },
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
  setBoardRows: (boardRows) => set({ boardRows }),
  setSideSort: (sideSort) => set({ sideSort }),
  setIndexModal: (indexModal) => set({ indexModal }),
  setIndexReturn: (indexReturn) => set({ indexReturn }),
  setMarketStat: (marketStat) => set({ marketStat }),
  setConnected: (connected) => set({ connected }),
}));
