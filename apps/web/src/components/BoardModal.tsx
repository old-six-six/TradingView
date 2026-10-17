import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api, type Bar, type BoardKind, type BoardStock, type IndicatorSeries } from '../api';
import { useStore } from '../store';
import { cls, fmtAmount, fmtNum, fmtPct } from '../fmt';

const UP = '#d93026';
const DOWN = '#12894f';
const UP_SOFT = 'rgba(217,48,38,0.5)';
const DOWN_SOFT = 'rgba(18,137,79,0.5)';
const MA_COLORS = ['#c98a12', '#1f6feb', '#8b5cf6', '#6b7280'];

/** 量柱轴用中文单位，避免出现 60000000.0 这种长数字 */
const VOLUME_FORMAT = {
  type: 'custom' as const,
  formatter: (v: number) => {
    if (!Number.isFinite(v)) return '';
    if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
    return v.toFixed(0);
  },
  minMove: 1,
};

const KIND_LABEL: Record<BoardKind, string> = { hy: '行业板块', gn: '概念板块', dy: '地域板块' };
const PERIODS: Array<{ key: 'day' | 'week' | 'month'; label: string }> = [
  { key: 'day', label: '日K' },
  { key: 'week', label: '周K' },
  { key: 'month', label: '月K' },
];

export interface BoardRef {
  code: string;
  name: string;
  kind: BoardKind;
  changePct: number;
}

function toTs(dateStr: string): number {
  const [y, mo, d] = (dateStr ?? '').split('-').map(Number);
  return Date.UTC(y, mo - 1, d) / 1000;
}

type SortKey = 'changePct' | 'turnoverRate' | 'amount' | 'price';

export default function BoardModal({ board, onClose }: { board: BoardRef; onClose: () => void }) {
  const { select } = useStore();
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');
  const [bars, setBars] = useState<Bar[]>([]);
  const [series, setSeries] = useState<IndicatorSeries | null>(null);
  const [stocks, setStocks] = useState<BoardStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'changePct', dir: -1 });

  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<any>[]>([]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 板块 K 线
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api
      .boardKline(board.code, period, 400)
      .then((r) => {
        if (!alive) return;
        setBars(r.bars);
        setSeries(r.series);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [board.code, period]);

  // 成分股
  useEffect(() => {
    let alive = true;
    setListLoading(true);
    api
      .boardStocks(board.code, board.kind)
      .then((r) => alive && setStocks(r.items))
      .catch(() => alive && setStocks([]))
      .finally(() => alive && setListLoading(false));
    return () => {
      alive = false;
    };
  }, [board.code, board.kind]);

  // 建图
  useEffect(() => {
    if (!hostRef.current) return;
    const chart = createChart(hostRef.current, {
      layout: {
        background: { color: '#ffffff' },
        textColor: '#5b6169',
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: '#e3e6ea', separatorHoverColor: '#d0d5db' },
      },
      grid: { vertLines: { color: '#f2f3f5' }, horzLines: { color: '#f2f3f5' } },
      rightPriceScale: { borderColor: '#e3e6ea', scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: {
        borderColor: '#e3e6ea',
        rightOffset: 3,
        barSpacing: 6,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (time: any, type?: number) => {
          if (typeof time !== 'number') return '';
          const d = new Date(time * 1000);
          const y = d.getUTCFullYear();
          const mo = d.getUTCMonth() + 1;
          const da = d.getUTCDate();
          if (type === 0) return `${y}`;
          if (type === 1) return `${mo}月`;
          if (type === 2) return `${mo}/${da}`;
          return `${mo}/${da}`;
        },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: '#b0b6bd', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#5b6169' },
        horzLine: { color: '#b0b6bd', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#5b6169' },
      },
    });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => {
      if (hostRef.current) {
        chart.applyOptions({
          width: hostRef.current.clientWidth,
          height: hostRef.current.clientHeight,
        });
      }
    });
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, []);

  // 画 K 线
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of seriesRef.current) {
      try {
        chart.removeSeries(s);
      } catch {
        /* 已移除 */
      }
    }
    seriesRef.current = [];
    if (!bars.length) return;

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    candles.setData(
      bars.map((b) => ({
        time: toTs(b.date) as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );
    seriesRef.current.push(candles);

    if (series) {
      const line = (values: number[], color: string) => {
        const s = chart.addSeries(
          LineSeries,
          {
            color,
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          },
          0,
        );
        const pts: Array<{ time: UTCTimestamp; value: number }> = [];
        for (let i = 0; i < values.length && i < bars.length; i++) {
          const v = values[i];
          if (!Number.isFinite(v)) continue;
          pts.push({ time: toTs(bars[i].date) as UTCTimestamp, value: v });
        }
        s.setData(pts);
        seriesRef.current.push(s);
      };
      [series.ma5, series.ma10, series.ma20, series.ma60].forEach((v, i) => line(v, MA_COLORS[i]));
    }

    const vol = chart.addSeries(
      HistogramSeries,
      { priceFormat: VOLUME_FORMAT, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    vol.setData(
      bars.map((b) => ({
        time: toTs(b.date) as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? UP_SOFT : DOWN_SOFT,
      })),
    );
    seriesRef.current.push(vol);

    chart.panes().forEach((p, i) => {
      try {
        p.setStretchFactor(i === 0 ? 0.76 : 0.24);
      } catch {
        /* 版本不支持则用默认分配 */
      }
    });
    const show = Math.min(120, bars.length);
    chart.timeScale().setVisibleLogicalRange({ from: bars.length - show - 0.5, to: bars.length + 1.5 });
  }, [bars, series]);

  const sorted = useMemo(() => {
    const list = [...stocks];
    list.sort((a, b) => {
      const cmp = Number(a[sort.key]) - Number(b[sort.key]);
      return sort.dir === -1 ? -cmp : cmp;
    });
    return list;
  }, [stocks, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === -1 ? 1 : -1 } : { key, dir: -1 }));

  const head = (key: SortKey, label: string, align: 'left' | 'right' = 'right') => (
    <th
      className={sort.key === key ? 'on' : ''}
      style={{ textAlign: align }}
      onClick={() => toggleSort(key)}
    >
      {label}
      {sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  );

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="board-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bm-head">
          <span className="bm-name">{board.name}</span>
          <span className={`bm-pct num ${cls(board.changePct)}`}>{fmtPct(board.changePct)}</span>
          <span className="bm-tag">{KIND_LABEL[board.kind] ?? '板块'}</span>
          <span className="bm-sub">{listLoading ? '成分股加载中…' : `${stocks.length} 只`}</span>
          <button className="bm-close" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>

        <div className="bm-body">
          <div className="bm-chart-wrap">
            <div className="bm-periods">
              {PERIODS.map((p) => (
                <span
                  key={p.key}
                  className={`bm-tab${period === p.key ? ' active' : ''}`}
                  onClick={() => setPeriod(p.key)}
                >
                  {p.label}
                </span>
              ))}
              <span className="bm-chart-tip">指数由成分股市值加权合成</span>
            </div>
            <div className="bm-chart" ref={hostRef}>
              {loading && <div className="bm-chart-loading">加载中…</div>}
              {!loading && error && <div className="bm-chart-loading">加载失败：{error}</div>}
              {!loading && !error && !bars.length && <div className="bm-chart-loading">暂无数据</div>}
            </div>
          </div>

          <div className="bm-list">
            <table className="bm-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>名称</th>
                  {head('price', '现价')}
                  {head('changePct', '涨幅')}
                  {head('turnoverRate', '换手')}
                  {head('amount', '成交额')}
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => (
                  <tr
                    key={s.symbol}
                    onClick={() => {
                      select(s.symbol);
                      onClose();
                    }}
                    title={`${s.name} ${s.code}　点击查看该股`}
                  >
                    <td className="bm-stock-name">
                      <span>{s.name}</span>
                      <i>{s.code}</i>
                    </td>
                    <td className={`num ${cls(s.changePct)}`}>{fmtNum(s.price)}</td>
                    <td className={`num ${cls(s.changePct)}`}>{fmtPct(s.changePct)}</td>
                    <td className="num">{fmtNum(s.turnoverRate)}%</td>
                    <td className="num">{fmtAmount(s.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!listLoading && !sorted.length && <div className="bm-empty">暂无成分股</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
