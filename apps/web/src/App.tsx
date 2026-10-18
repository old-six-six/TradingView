import { useCallback, useEffect, useRef } from 'react';
import { api, type Quote } from './api';
import { useStore } from './store';
import { backToChart } from './nav';
import TopBar from './components/TopBar';
import WatchList from './components/WatchList';
import ChartPane from './components/ChartPane';
import OrderBook from './components/OrderBook';
import MarketPage, { MARKET_TABS } from './components/MarketPage';
import StatusBar from './components/StatusBar';

export default function App() {
  const { items, selected, setItems, mergeQuotes, setConnected, select, market, setMarket, sidebar, entry, boardMembers } =
    useStore();
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number>(0);
  const itemsRef = useRef(items);
  const selectedRef = useRef(selected);
  itemsRef.current = items;
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
    // 只有五大市场列表点进来的才认这个来源，脏值当没有
    if (f && MARKET_TABS.some((t) => t.key === f)) useStore.getState().setEntry(f);
    api
      .watchlist()
      .then((r) => {
        setItems(r.items);
        const first = s || r.items[0]?.symbol;
        if (first) select(first);
      })
      .catch(() => undefined);
  }, [setItems, select, setMarket]);

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
   * 「当前位置」板块的成员名单。列表页点进来时会带着名单一起过来（members），
   * 刷新后没有这份缓存就补拉一次轻量接口（只含 symbol/code/name，几十毫秒）。
   */
  useEffect(() => {
    const st = useStore.getState();
    if (!entry) {
      if (st.boardMembers) st.setBoardMembers(null);
      return;
    }
    if (st.boardMembers?.board === entry && st.boardMembers.symbols.length) return;
    let alive = true;
    api.marketUniverse(entry).then(
      (r) => {
        if (!alive || r.board !== entry) return;
        useStore.getState().setBoardMembers({ board: entry, symbols: r.rows.map((x) => x.symbol) });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [entry, boardMembers]);

  const move = useCallback(
    (dir: 1 | -1) => {
      const st = useStore.getState();
      const board = st.entry;
      // 从某个市场列表点进来的：只在那个板块里按代码顺序翻，出界就停住
      if (board) {
        const members = st.boardMembers;
        // 名单还没到：宁可这次不动，也别串到自选列表里跳乱
        if (members?.board !== board || !members.symbols.length) return;
        const list = members.symbols;
        const idx = list.indexOf(st.selected);
        const cur = idx >= 0 ? idx : dir > 0 ? -1 : list.length;
        const next = list[cur + dir];
        // 第二个参数带着来源板块，否则会被当成自选切换把「当前位置」清掉
        if (next) st.select(next, board);
        return;
      }
      const list = itemsRef.current;
      if (!list.length) return;
      const idx = list.findIndex((i) => i.symbol === st.selected);
      const next = list[Math.max(0, Math.min(list.length - 1, idx + dir))];
      if (next) st.select(next.symbol);
    },
    [],
  );

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
            {sidebar && <WatchList />}
            <ChartPane />
            <OrderBook />
          </>
        )}
      </div>
      <StatusBar />
    </div>
  );
}
