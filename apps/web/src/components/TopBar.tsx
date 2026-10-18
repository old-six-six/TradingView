import { useEffect, useRef, useState } from 'react';
import { api, type Quote } from '../api';
import { useStore } from '../store';
import { registerSearchFocus } from '../searchBus';
import { cls, fmtNum, fmtPct } from '../fmt';
import IndexModal from './IndexModal';

const INDEXES = [
  { symbol: 'sh000001', label: '上证', market: 'sh_main', full: '上证主板' },
  { symbol: 'sz399001', label: '深证', market: 'sz_main', full: '深证主板' },
  { symbol: 'sz399006', label: '创业板', market: 'cyb', full: '创业板' },
  { symbol: 'sh000688', label: '科创50', market: 'kcb', full: '科创板' },
  { symbol: 'bj899050', label: '北证50', market: 'bj', full: '北交所' },
];

/** 最近搜索：{symbol, code, name, at}，最多留 10 条 */
interface Recent {
  symbol: string;
  code: string;
  name: string;
  at: number;
}

const RECENT_KEY = 'tv.recentSearch';
const RECENT_MAX = 10;

function loadRecent(): Recent[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr
        .filter((r) => r && typeof r.symbol === 'string' && r.symbol.length >= 8)
        .slice(0, RECENT_MAX);
    }
  } catch {
    /* 忽略损坏的本地记录 */
  }
  return [];
}

function saveRecent(list: Recent[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

export default function TopBar() {
  const {
    connected,
    stale,
    items,
    setItems,
    select,
    market,
    indexModal,
    setIndexModal,
    setIndexReturn,
  } = useStore();
  const [idx, setIdx] = useState<Record<string, Quote>>({});
  const [kw, setKw] = useState('');
  const [results, setResults] = useState<Array<{ symbol: string; code: string; name: string }>>([]);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<Recent[]>(loadRecent);
  const timer = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);

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

  /** 供其它组件（自选、图表键盘输入）唤起搜索框 */
  useEffect(
    () =>
      registerSearchFocus((seed) => {
        if (seed) setKw(seed);
        inputRef.current?.focus();
        setOpen(true);
      }),
    [],
  );

  /**
   * 页面上直接敲字母/数字就把焦点送进搜索框。
   * 中文输入法不处理（keydown 拿到的是 Process），修饰键组合也不抢。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1 || !/[0-9a-zA-Z]/.test(e.key)) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      e.preventDefault();
      // 首字符替换旧内容，后续字符由聚焦后的输入框原生接着打
      setKw(e.key);
      inputRef.current?.focus();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const remember = (it: { symbol: string; code: string; name: string }) => {
    setRecent((prev) => {
      const next = [
        { symbol: it.symbol, code: it.code, name: it.name, at: Date.now() },
        ...prev.filter((r) => r.symbol !== it.symbol),
      ].slice(0, RECENT_MAX);
      saveRecent(next);
      return next;
    });
  };

  const pick = async (it: { symbol: string; code: string; name: string }) => {
    remember(it);
    if (!items.some((i) => i.symbol === it.symbol)) {
      await api.addWatch(it.symbol, it.name).catch(() => undefined);
      const r = await api.watchlist().catch(() => null);
      if (r) setItems(r.items);
    }
    select(it.symbol);
    setKw('');
    setOpen(false);
  };

  const clearRecent = () => {
    setRecent([]);
    saveRecent([]);
  };

  const typing = kw.trim().length > 0;
  const showDrop = open && (typing ? results.length > 0 : recent.length > 0);

  return (
    <div className="topbar">
      <div className="brand">TradingView</div>

      <div className="search-box">
        <input
          ref={inputRef}
          value={kw}
          placeholder="代码 / 名称 / 拼音首字母"
          onChange={(e) => setKw(e.target.value)}
          onFocus={() => setOpen(true)}
          // 选完票后输入框仍是焦点的，再点一次不会触发 focus，得靠 click 补上
          onClick={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 160)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) {
              void pick(results[0]);
            } else if (e.key === 'Escape') {
              setKw('');
              setOpen(false);
              inputRef.current?.blur();
            }
          }}
        />
        {showDrop && typing && (
          <div className="search-drop">
            {results.map((r) => (
              <div key={r.symbol} className="search-item" onMouseDown={() => void pick(r)}>
                <span>{r.name}</span>
                <span className="num" style={{ color: 'var(--text-3)' }}>
                  {r.code}
                </span>
              </div>
            ))}
          </div>
        )}
        {showDrop && !typing && (
          <div className="search-drop">
            <div className="search-cap">
              <span>最近搜索</span>
              <span
                className="search-clear"
                onMouseDown={(e) => {
                  e.preventDefault();
                  clearRecent();
                }}
              >
                清除
              </span>
            </div>
            {recent.map((r) => (
              <div key={r.symbol} className="search-item" onMouseDown={() => void pick(r)}>
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
            <span
              key={i.symbol}
              className={`idx-item${market === i.market ? ' on' : ''}`}
              onClick={() => {
                // 这是自己主动点开的弹窗，之前挂着的「返回某个弹窗」就不作数了
                setIndexReturn(null);
                setIndexModal(i);
              }}
              title={`查看${i.full}分时（可切分钟/日周月K）`}
            >
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

      {indexModal && <IndexModal info={indexModal} onClose={() => setIndexModal(null)} />}
    </div>
  );
}
