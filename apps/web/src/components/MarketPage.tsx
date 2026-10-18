import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type MarketRow } from '../api';
import { useStore } from '../store';
import { gotoChart } from '../nav';
import { cls, fmtNum, fmtPct } from '../fmt';

export const MARKET_TABS = [
  { key: 'sh_main', label: '上证主板' },
  { key: 'sz_main', label: '深证主板' },
  { key: 'cyb', label: '创业板' },
  { key: 'kcb', label: '科创板' },
  { key: 'bj', label: '北交所' },
] as const;

/**
 * 五大市场的简称。列表页 tab 用的是全称（上证主板/北交所），
 * 但图表底部「当前位置」要贴着顶栏指数的叫法写。
 */
export const MARKET_POS_LABEL: Record<string, string> = {
  sh_main: '上证',
  sz_main: '深证',
  cyb: '创业板',
  kcb: '科创',
  bj: '北证',
};

/** 列表刷新间隔。服务端有 2.5s 缓存，太快只会打上游 */
const POLL_MS = 4000;
const ROW_H = 24;
const HEAD_H = 28;

type SortKey = keyof MarketRow | 'none';

interface Col {
  key: SortKey;
  label: string;
  w: number;
  align?: 'l' | 'r';
  tip?: string;
  /** 数值列取哪个字段排序 */
  num?: (r: MarketRow) => number;
  text?: (r: MarketRow) => string;
  cell: (r: MarketRow) => { v: string; c?: string };
}

/** 手数用紧凑写法，表格里不再带空格 */
function hands(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '--';
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return `${v.toFixed(0)}`;
}

function money(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '--';
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return v.toFixed(0);
}

function px(v: number): string {
  return v > 0 ? fmtNum(v) : '--';
}

const COLS: Col[] = [
  {
    key: 'code',
    label: '代码',
    w: 66,
    align: 'l',
    text: (r) => r.code,
    cell: (r) => ({ v: r.code }),
  },
  {
    key: 'name',
    label: '名称',
    w: 82,
    align: 'l',
    text: (r) => r.name,
    cell: (r) => ({ v: r.name }),
  },
  {
    key: 'price',
    label: '最新',
    w: 68,
    num: (r) => r.price,
    cell: (r) => ({ v: px(r.price), c: cls(r.changePct) }),
  },
  {
    key: 'changePct',
    label: '涨幅',
    w: 68,
    num: (r) => r.changePct,
    cell: (r) => ({ v: r.price > 0 ? fmtPct(r.changePct) : '--', c: cls(r.changePct) }),
  },
  {
    key: 'change',
    label: '涨跌',
    w: 66,
    num: (r) => r.change,
    cell: (r) => ({
      v: r.price > 0 ? `${r.change > 0 ? '+' : ''}${fmtNum(r.change)}` : '--',
      c: cls(r.change),
    }),
  },
  {
    key: 'turnoverRate',
    label: '换手率',
    w: 66,
    num: (r) => r.turnoverRate,
    cell: (r) => ({ v: r.price > 0 ? `${fmtNum(r.turnoverRate)}%` : '--' }),
  },
  {
    key: 'volumeRatio',
    label: '量比',
    w: 56,
    num: (r) => r.volumeRatio,
    cell: (r) => ({ v: r.price > 0 ? fmtNum(r.volumeRatio) : '--' }),
  },
  {
    key: 'speed',
    label: '涨速',
    w: 62,
    tip: '5 分钟涨速，由本地快照推算',
    num: (r) => r.speed ?? -999,
    cell: (r) => ({
      v: r.price > 0 && r.speed !== null ? fmtPct(r.speed) : '--',
      c: cls(r.speed),
    }),
  },
  {
    key: 'amount',
    label: '总额',
    w: 74,
    num: (r) => r.amount,
    cell: (r) => ({ v: money(r.amount) }),
  },
  {
    key: 'volume',
    label: '总手',
    w: 74,
    num: (r) => r.volume,
    cell: (r) => ({ v: hands(r.volume) }),
  },
  {
    key: 'nowVolume',
    label: '现手',
    w: 62,
    tip: '距上次刷新新增的成交量',
    num: (r) => r.nowVolume,
    cell: (r) => ({ v: r.nowVolume > 0 ? hands(r.nowVolume) : '--' }),
  },
  {
    key: 'high',
    label: '最高',
    w: 60,
    num: (r) => r.high,
    cell: (r) => ({ v: px(r.high), c: cls(r.high - r.prevClose) }),
  },
  {
    key: 'low',
    label: '最低',
    w: 60,
    num: (r) => r.low,
    cell: (r) => ({ v: px(r.low), c: cls(r.low - r.prevClose) }),
  },
  {
    key: 'industry',
    label: '行业',
    w: 86,
    align: 'l',
    text: (r) => r.industry,
    cell: (r) => ({ v: r.industry || '--', c: 'dim' }),
  },
  {
    key: 'pe',
    label: 'PE',
    w: 58,
    tip: '腾讯口径市盈率（TTM）',
    num: (r) => r.pe ?? -1,
    cell: (r) => ({ v: r.pe ? fmtNum(r.pe) : '--', c: 'dim' }),
  },
  {
    key: 'peDyn',
    label: '市盈率',
    w: 64,
    tip: '动态市盈率',
    num: (r) => r.peDyn ?? -1,
    cell: (r) => ({ v: r.peDyn ? fmtNum(r.peDyn) : '--', c: 'dim' }),
  },
  {
    key: 'pb',
    label: '市净率',
    w: 62,
    num: (r) => r.pb ?? -1,
    cell: (r) => ({ v: r.pb ? fmtNum(r.pb) : '--', c: 'dim' }),
  },
  {
    key: 'floatCap',
    label: '流通市值',
    w: 82,
    num: (r) => r.floatCap,
    cell: (r) => ({ v: money(r.floatCap), c: 'dim' }),
  },
  {
    key: 'marketCap',
    label: '总市值',
    w: 82,
    num: (r) => r.marketCap,
    cell: (r) => ({ v: money(r.marketCap), c: 'dim' }),
  },
  {
    key: 'outer',
    label: '外盘',
    w: 72,
    num: (r) => r.outer,
    cell: (r) => ({ v: hands(r.outer), c: 'up' }),
  },
  {
    key: 'inner',
    label: '内盘',
    w: 72,
    num: (r) => r.inner,
    cell: (r) => ({ v: hands(r.inner), c: 'down' }),
  },
  {
    key: 'prevClose',
    label: '昨收',
    w: 64,
    num: (r) => r.prevClose,
    cell: (r) => ({ v: px(r.prevClose), c: 'dim' }),
  },
  {
    key: 'open',
    label: '今开',
    w: 64,
    num: (r) => r.open,
    cell: (r) => ({ v: px(r.open), c: cls(r.open - r.prevClose) }),
  },
  {
    key: 'bidPrice',
    label: '委买价',
    w: 70,
    num: (r) => r.bidPrice,
    cell: (r) => ({ v: px(r.bidPrice), c: 'up' }),
  },
  {
    key: 'askPrice',
    label: '委卖价',
    w: 70,
    num: (r) => r.askPrice,
    cell: (r) => ({ v: px(r.askPrice), c: 'down' }),
  },
  {
    key: 'avgPrice',
    label: '均价',
    w: 64,
    num: (r) => r.avgPrice,
    cell: (r) => ({ v: px(r.avgPrice), c: cls(r.avgPrice - r.prevClose) }),
  },
  {
    key: 'weibi',
    label: '委比',
    w: 66,
    tip: '委差 / 五档委托总量',
    num: (r) => r.weibi,
    cell: (r) => ({ v: r.price > 0 ? fmtPct(r.weibi) : '--', c: cls(r.weibi) }),
  },
  {
    key: 'weicha',
    label: '委差',
    w: 66,
    num: (r) => r.weicha,
    cell: (r) => ({
      v: r.price > 0 ? `${r.weicha > 0 ? '+' : ''}${r.weicha.toFixed(0)}` : '--',
      c: cls(r.weicha),
    }),
  },
];

const TOTAL_W = COLS.reduce((s, c) => s + c.w, 0);

export default function MarketPage({ board }: { board: string }) {
  const { setMarketStat } = useStore();
  const [rows, setRows] = useState<MarketRow[]>([]);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'code', dir: 1 });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(520);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = () => {
      api
        .marketList(board)
        .then((r) => {
          if (!alive || r.board !== board) return;
          if ('error' in r) {
            setErr('未知市场');
            return;
          }
          setErr('');
          setRows(r.rows);
          setUpdatedAt(r.updatedAt);
        })
        .catch((e) => alive && setErr((e as Error).message))
        .finally(() => alive && setLoading(false));
    };
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [board]);

  // 切市场时回到顶部
  useEffect(() => {
    setScrollTop(0);
    if (boxRef.current) boxRef.current.scrollTop = 0;
  }, [board]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const sorted = useMemo(() => {
    if (sort.key === 'none') return rows;
    const col = COLS.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.num
      ? col.num
      : col.text
        ? (r: MarketRow) => col.text!(r)
        : () => 0;
    const list = [...rows];
    list.sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (typeof va === 'string' || typeof vb === 'string') {
        const c = String(va).localeCompare(String(vb));
        return c * sort.dir;
      }
      const d = (va as number) - (vb as number);
      return (d === 0 ? 0 : d > 0 ? 1 : -1) * sort.dir;
    });
    return list;
  }, [rows, sort]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const end = Math.min(sorted.length, Math.ceil((scrollTop + viewH) / ROW_H) + 8);
  const slice = sorted.slice(start, end);

  const upCount = rows.filter((r) => r.changePct > 0).length;
  const downCount = rows.filter((r) => r.changePct < 0).length;
  const label = MARKET_TABS.find((t) => t.key === board)?.label ?? board;

  // 汇总信息交给状态栏显示（本组件不再自带顶栏）
  useEffect(() => {
    setMarketStat({
      key: board,
      label: err || label,
      count: rows.length,
      up: upCount,
      down: downCount,
      updatedAt,
      loading: loading && !rows.length,
    });
  }, [board, label, err, rows.length, upCount, downCount, updatedAt, loading, setMarketStat]);

  // 离开列表页时清掉，免得图表页状态栏还挂着上一个市场
  useEffect(() => () => useStore.getState().setMarketStat(null), []);

  const sortBy = (col: Col) => {
    if (col.key === 'none') return;
    setSort((prev) => {
      if (prev.key === col.key) {
        if (prev.dir === -1) return { key: col.key, dir: 1 };
        return { key: 'none', dir: 1 };
      }
      // 文本列默认升序，数值列默认降序
      return { key: col.key, dir: col.text ? 1 : -1 };
    });
    if (boxRef.current) boxRef.current.scrollTop = 0;
    setScrollTop(0);
  };

  return (
    <div className="mk-page">
      <div
        className="mk-scroll"
        ref={boxRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <div className="mk-inner" style={{ width: TOTAL_W }}>
          <div className="mk-head" style={{ height: HEAD_H }}>
            {COLS.map((c) => {
              const on = sort.key === c.key;
              return (
                <span
                  key={c.key}
                  className={`mk-th${on ? ' on' : ''}${c.align === 'l' ? '' : ' r'}`}
                  style={{ width: c.w }}
                  title={c.tip ?? `按${c.label}排序`}
                  onClick={() => sortBy(c)}
                >
                  {c.label}
                  {on && <i>{sort.dir === -1 ? '↓' : '↑'}</i>}
                </span>
              );
            })}
          </div>
          <div style={{ height: start * ROW_H }} />
          {slice.map((r) => (
            <div
              className="mk-row"
              key={r.symbol}
              style={{ height: ROW_H }}
              onClick={() => gotoChart(r.symbol, board)}
              title={`${r.name} ${r.code}`}
            >
              {COLS.map((c) => {
                const { v, c: cl } = c.cell(r);
                return (
                  <span
                    key={c.key}
                    className={`mk-td num ${cl ?? ''}${c.align === 'l' ? '' : ' r'}`}
                    style={{ width: c.w }}
                  >
                    {v}
                  </span>
                );
              })}
            </div>
          ))}
          <div style={{ height: Math.max(0, (sorted.length - end) * ROW_H) }} />
        </div>
      </div>
    </div>
  );
}
