import { useEffect, useRef, useState } from 'react';
import { api, type Quote } from '../api';
import { useStore } from '../store';
import { cls, fmtNum, fmtPct } from '../fmt';

const INDEXES = [
  { symbol: 'sh000001', label: '上证' },
  { symbol: 'sz399001', label: '深证' },
  { symbol: 'sz399006', label: '创业板' },
];

export default function TopBar() {
  const { connected, stale, items, setItems, select } = useStore();
  const [idx, setIdx] = useState<Record<string, Quote>>({});
  const [kw, setKw] = useState('');
  const [results, setResults] = useState<Array<{ symbol: string; code: string; name: string }>>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<number>(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .quote(INDEXES.map((i) => i.symbol))
        .then((r) => {
          if (!alive) return;
          const map: Record<string, Quote> = {};
          for (const q of r.quotes) map[q.symbol] = q;
          setIdx(map);
        })
        .catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 10000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!kw.trim()) {
      setResults([]);
      return;
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api
        .search(kw.trim())
        .then((r) => {
          setResults(r.items);
          setOpen(true);
        })
        .catch(() => setResults([]));
    }, 280);
    return () => window.clearTimeout(timer.current);
  }, [kw]);

  const pick = async (symbol: string, name: string) => {
    if (!items.some((i) => i.symbol === symbol)) {
      await api.addWatch(symbol, name).catch(() => undefined);
      const r = await api.watchlist().catch(() => null);
      if (r) setItems(r.items);
    }
    select(symbol);
    setKw('');
    setOpen(false);
  };

  return (
    <div className="topbar">
      <div className="brand">TradingView</div>

      <div className="search-box">
        <input
          value={kw}
          placeholder="代码 / 名称，回车添加"
          onChange={(e) => setKw(e.target.value)}
          onFocus={() => kw && setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 160)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) {
              void pick(results[0].symbol, results[0].name);
            }
          }}
        />
        {open && results.length > 0 && (
          <div className="search-drop">
            {results.map((r) => (
              <div
                key={r.symbol}
                className="search-item"
                onMouseDown={() => void pick(r.symbol, r.name)}
              >
                <span>{r.name}</span>
                <span className="num" style={{ color: 'var(--text-3)' }}>
                  {r.code}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="index-row">
        {INDEXES.map((i) => {
          const q = idx[i.symbol];
          return (
            <span key={i.symbol}>
              {i.label}{' '}
              <span className={`num ${cls(q?.changePct)}`}>
                {q ? fmtNum(q.price, 2) : '--'} {q ? fmtPct(q.changePct) : ''}
              </span>
            </span>
          );
        })}
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center' }}>
        {stale && <span style={{ color: 'var(--down)', fontSize: 12 }}>数据延迟</span>}
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          <span
            className="status-dot"
            style={{ background: connected ? 'var(--down)' : 'var(--up)' }}
          />
          {connected ? '已连接' : '连接中'}
        </span>
      </div>
    </div>
  );
}
