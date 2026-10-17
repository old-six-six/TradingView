import { useCallback, useEffect, useRef } from 'react';
import { api, type Quote } from './api';
import { useStore } from './store';
import { backToChart } from './nav';
import TopBar from './components/TopBar';
import WatchList from './components/WatchList';
import ChartPane from './components/ChartPane';
import OrderBook from './components/OrderBook';
import MarketPage from './components/MarketPage';
import StatusBar from './components/StatusBar';

export default function App() {
  const { items, selected, setItems, mergeQuotes, setConnected, select, market, setMarket } =
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
    if (p) useStore.getState().setPeriod(p);
    if (b) setMarket(b);
    if (s) select(s);
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
    if (url.searchParams.get('symbol') === selected) return;
    url.searchParams.set('symbol', selected);
    history.replaceState(null, '', url);
  }, [selected]);

  const move = useCallback(
    (dir: 1 | -1) => {
      const list = itemsRef.current;
      if (!list.length) return;
      const idx = list.findIndex((i) => i.symbol === selectedRef.current);
      const next = list[Math.max(0, Math.min(list.length - 1, idx + dir))];
      if (next) select(next.symbol);
    },
    [select],
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
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
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
            <WatchList />
            <ChartPane />
            <OrderBook />
          </>
        )}
      </div>
      <StatusBar />
    </div>
  );
}
