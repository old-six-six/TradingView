import { useCallback, useEffect, useMemo, useRef } from 'react';
import { api, type Quote } from './api';
import { useStore, sortBoardRows } from './store';
import { sectionSymbols, isWatchEntry, watchEntryFolder, watchFolderRows, watchSections } from './sideOrder';
import { backToChart } from './nav';
import TopBar from './components/TopBar';
import WatchList from './components/WatchList';
import BoardSide from './components/BoardSide';
import ChartPane from './components/ChartPane';
import OrderBook from './components/OrderBook';
import MarketPage, { MARKET_TABS } from './components/MarketPage';
import StatusBar from './components/StatusBar';

/** 左侧板块列表的行情刷新间隔，和列表页的快照节奏差不多 */
const SIDE_POLL_MS = 15_000;

export default function App() {
  const {
    selected,
    items,
    folders,
    quotes,
    setItems,
    setFolders,
    mergeQuotes,
    setConnected,
    select,
    market,
    setMarket,
    sidebar,
    entry,
    boardRows,
    sideSort,
  } = useStore();
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number>(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const p = params.get('period');
    const s = params.get('symbol');
    const b = params.get('board');
    const f = params.get('from');
    if (p) useStore.getState().setPeriod(p);
    if (b) setMarket(b);
    if (s) select(s);
    // 五大市场列表点进来的，或者自己选了自选文件夹（w:xxx），都算「当前位置」
    if (f && (MARKET_TABS.some((t) => t.key === f) || isWatchEntry(f))) {
      useStore.getState().setEntry(f);
    }
    api
      .watchlist()
      .then((r) => {
        setItems(r.items);
        setFolders(r.folders ?? []);
        const first = s || r.items[0]?.symbol;
        if (first) select(first);
      })
      .catch(() => undefined);
  }, [setItems, setFolders, select, setMarket]);

  useEffect(() => {
    let closed = false;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
        if (selectedRef.current) {
          ws.send(JSON.stringify({ type: 'subscribe', symbol: selectedRef.current }));
        }
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'quote' || msg.type === 'snapshot') {
            mergeQuotes(msg.data as Quote[], msg.stale);
          }
        } catch {
          /* 忽略 */
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retryRef.current = Math.min(retryRef.current + 1, 6);
        setTimeout(connect, 800 * retryRef.current);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      wsRef.current?.close();
    };
  }, [mergeQuotes, setConnected]);

  useEffect(() => {
    if (!selected) return;
    api.detail(selected).catch(() => undefined);
  }, [selected]);

  /**
   * 地址栏始终跟随当前股票：切换入口有自选列表、板块弹窗、上下键三种，
   * 之前只有从市场列表点进来会写 URL，其余路径刷新后会跳回上一只票。
   */
  useEffect(() => {
    if (!selected) return;
    const url = new URL(location.href);
    let changed = false;
    if (url.searchParams.get('symbol') !== selected) {
      url.searchParams.set('symbol', selected);
      changed = true;
    }
    // 来源板块跟着一起写：换了票之后它就失效了，别留在地址栏上骗人
    const from = entry ?? null;
    if (url.searchParams.get('from') !== from) {
      if (from) url.searchParams.set('from', from);
      else url.searchParams.delete('from');
      changed = true;
    }
    if (changed) history.replaceState(null, '', url);
  }, [selected, entry]);

  /**
   * 「当前位置」的成员名单。板块来自轻量接口（列表页点进来时自带一份），
   * 自选文件夹直接由本地 items + 实时 quotes 派生，不用再请求。
   */
  useEffect(() => {
    if (!entry || isWatchEntry(entry)) {
      if (useStore.getState().boardRows) useStore.getState().setBoardRows(null);
      return;
    }
    let alive = true;
    const load = () =>
      api.marketLite(entry).then((r) => {
        if (!alive || r.board !== entry) return;
        const st = useStore.getState();
        // 第一次拿到这个板块的名单：当前票不在里面就落到第一只，
        // 否则从下拉切板块时会出现「位置变了但图里还是上一只票」
        const firstLoad = st.boardRows?.board !== entry;
        st.setBoardRows({ board: entry, rows: r.rows, at: r.at || Date.now() });
        if (firstLoad && r.rows.length && !r.rows.some((row) => row.symbol === st.selected)) {
          const head = sortBoardRows(r.rows, st.sideSort)[0];
          if (head) st.select(head.symbol, entry);
        }
      }, () => undefined);
    load();
    // 依赖只留 entry：boardRows 变化会重启定时器，轮询就断了
    const t = window.setInterval(load, SIDE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [entry]);

  /** 自选文件夹被删掉时，别把「当前位置」悬在一个不存在的位置上 */
  useEffect(() => {
    if (!isWatchEntry(entry)) return;
    const folder = watchEntryFolder(entry);
    if (folders.length && !folders.some((f) => f.name === folder)) {
      useStore.getState().setEntry(null);
    }
  }, [entry, folders]);

  /** 左侧列表当前的顺序，【 】就按它走 */
  const boardOrder = useMemo(() => {
    if (!entry) return null;
    const rows = isWatchEntry(entry)
      ? watchFolderRows(items, folders, quotes, watchEntryFolder(entry) ?? '')
      : boardRows?.board === entry
        ? boardRows.rows
        : null;
    if (!rows?.length) return null;
    return sortBoardRows(rows, sideSort).map((r) => r.symbol);
  }, [entry, items, folders, quotes, boardRows, sideSort]);
  const boardOrderRef = useRef<string[] | null>(null);
  boardOrderRef.current = boardOrder;

  const move = useCallback((dir: 1 | -1) => {
    const st = useStore.getState();
    const board = st.entry;
    // 从某个市场列表点进来的：只在那个板块里按左侧列表的顺序翻，出界就停住
    if (board) {
      const list = boardOrderRef.current;
      // 名单还没到：宁可这次不动，也别串到自选列表里跳乱
      if (!list?.length) return;
      const idx = list.indexOf(st.selected);
      const cur = idx >= 0 ? idx : dir > 0 ? -1 : list.length;
      const next = list[cur + dir];
      // 第二个参数带着来源板块，否则会被当成自选切换把「当前位置」清掉
      if (next) st.select(next, board);
      return;
    }
    // 自选：和左侧列表完全同一套顺序（文件夹顺序 + 组内当前排序），出界就停住
    const order = sectionSymbols(watchSections(st.items, st.folders, st.quotes), st.sideSort);
    if (!order.length) return;
    const idx = order.indexOf(st.selected);
    const cur = idx >= 0 ? idx : dir > 0 ? -1 : order.length;
    const next = order[cur + dir];
    if (next) st.select(next);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // 列表页里 Esc 退回图表
      if (e.key === 'Escape') {
        if (useStore.getState().market) {
          e.preventDefault();
          backToChart();
        }
        return;
      }
      // 列表页的上下键交给表格自己滚，不再切自选
      if (useStore.getState().market) return;
      // 【 上一只 / 】 下一只（上下键已改给图表做缩放）。
      // 中文输入法下 e.key 会是全角括号，e.code 仍是 Bracket*，两个都认
      const up = e.key === '[' || e.key === '【' || e.code === 'BracketLeft';
      const down = e.key === ']' || e.key === '】' || e.code === 'BracketRight';
      if (up) {
        e.preventDefault();
        move(-1);
      } else if (down) {
        e.preventDefault();
        move(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move]);

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        {market ? (
          <MarketPage board={market} />
        ) : (
          <>
            {sidebar &&
              // 有「当前位置」（板块或自选文件夹）时左侧列它的成员，否则列全部自选
              (entry ? <BoardSide /> : <WatchList />)}
            <ChartPane />
            <OrderBook />
          </>
        )}
      </div>
      <StatusBar />
    </div>
  );
}
