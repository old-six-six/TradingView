import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  AreaSeries,
  CandlestickSeries,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api, type Bar, type MinutePoint, type Quote } from '../api';
import { gotoMarketFromIndex } from '../nav';
import { isIntraday, PERIODS } from '../chartPresets';
import type { IndexRef } from '../store';
import { cls, fmtNum, fmtPct } from '../fmt';

export type { IndexRef };

const UP = '#d93026';
const DOWN = '#12894f';
const UP_SOFT = 'rgba(217,48,38,0.5)';
const DOWN_SOFT = 'rgba(18,137,79,0.5)';

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

function tsOf(dateStr: string): number {
  const m = (dateStr ?? '').trim();
  if (!m) return 0;
  if (m.length <= 10) {
    const [y, mo, d] = m.split('-').map(Number);
    return Date.UTC(y, mo - 1, d) / 1000;
  }
  const [datePart, timePart] = m.split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [hh, mi] = timePart.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, hh, mi) / 1000;
}

/**
 * 顶栏五大板块指数弹窗：默认看分时，可切 5/15/30/60 分和日/周/月 K。
 * 用的是主图同一套 K 线接口（指数代码如 sh000001 直接支持），
 * 分时单独走 /api/minute，基准线取实时行情的昨收。
 */
export default function IndexModal({ info, onClose }: { info: IndexRef; onClose: () => void }) {
  const [period, setPeriod] = useState('minute');
  const [bars, setBars] = useState<Bar[]>([]);
  const [date, setDate] = useState('');
  const [points, setPoints] = useState<MinutePoint[]>([]);
  const [prevClose, setPrevClose] = useState(0);
  const [q, setQ] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<any>[]>([]);

  // Esc 关闭。忽略「本组件刚挂载前」就发生的那一下 Esc：
  // 从列表页 Esc 退回弹窗时，是同一个键盘事件把弹窗重新打开的，不能被它顺手再关掉
  useEffect(() => {
    const born = performance.now();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.timeStamp < born) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 实时报价：头部价格 + 分时的昨收基准
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .quote([info.symbol])
        .then((r) => {
          if (!alive) return;
          const first = r.quotes[0];
          if (first) {
            setQ(first);
            if (first.prevClose > 0) setPrevClose(first.prevClose);
          }
        })
        .catch(() => undefined);
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [info.symbol]);

  // 数据：分时走 minute 接口，其余周期走 kline
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    if (period === 'minute') {
      api
        .minute(info.symbol)
        .then((r) => {
          if (!alive) return;
          setDate(r.date);
          setPoints(r.points ?? []);
          if (r.prevClose > 0) setPrevClose(r.prevClose);
        })
        .catch((e: Error) => alive && setError(e.message))
        .finally(() => alive && setLoading(false));
    } else {
      api
        .kline(info.symbol, period, 400)
        .then((r) => {
          if (!alive) return;
          setBars(r.bars ?? []);
        })
        .catch((e: Error) => alive && setError(e.message))
        .finally(() => alive && setLoading(false));
    }
    return () => {
      alive = false;
    };
  }, [info.symbol, period]);

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
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (time: any, type?: number) => {
          if (typeof time !== 'number') return '';
          const d = new Date(time * 1000);
          const mo = d.getUTCMonth() + 1;
          const da = d.getUTCDate();
          const hh = String(d.getUTCHours()).padStart(2, '0');
          const mi = String(d.getUTCMinutes()).padStart(2, '0');
          if (type === 0) return `${d.getUTCFullYear()}`;
          if (type === 1) return `${mo}月`;
          if (type === 2) return `${mo}/${da}`;
          return `${hh}:${mi}`;
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

  // 重画
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

    // 时间轴：分钟级别显示时分，日线以上只显示日期
    chart.applyOptions({ timeScale: { timeVisible: isIntraday(period) } });

    if (period === 'minute') {
      if (!points.length) return;
      const last = points[points.length - 1].price;
      const up = prevClose > 0 ? last >= prevClose : true;
      const color = up ? UP : DOWN;

      const area = chart.addSeries(AreaSeries, {
        lineColor: color,
        topColor: up ? 'rgba(217,48,38,0.16)' : 'rgba(18,137,79,0.16)',
        bottomColor: 'rgba(255,255,255,0)',
        lineWidth: 1,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        priceLineVisible: false,
        lastValueVisible: true,
      });
      area.setData(points.map((p) => ({ time: tsOf(`${date} ${p.time}`) as UTCTimestamp, value: p.price })));
      seriesRef.current.push(area);

      if (prevClose > 0) {
        area.createPriceLine({
          price: prevClose,
          color: '#8b929b',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '昨收',
        });
      }

      const vol = chart.addSeries(
        HistogramSeries,
        { priceFormat: VOLUME_FORMAT, priceLineVisible: false, lastValueVisible: false },
        1,
      );
      vol.setData(
        points.map((p) => ({
          time: tsOf(`${date} ${p.time}`) as UTCTimestamp,
          value: p.volume,
          color: p.price >= (prevClose || p.price) ? UP_SOFT : DOWN_SOFT,
        })),
      );
      seriesRef.current.push(vol);

      chart.panes().forEach((p, i) => {
        try {
          p.setStretchFactor(i === 0 ? 0.76 : 0.24);
        } catch {
          /* 版本不支持就用默认分配 */
        }
      });
      chart.timeScale().fitContent();
      return;
    }

    if (!bars.length) return;
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      // 默认会画一条贯穿全图的现价虚线，弹窗里太碍眼，只保留右侧价格标签
      priceLineVisible: false,
    });
    candles.setData(
      bars.map((b) => ({
        time: tsOf(b.date) as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );
    seriesRef.current.push(candles);

    const vol = chart.addSeries(
      HistogramSeries,
      { priceFormat: VOLUME_FORMAT, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    vol.setData(
      bars.map((b) => ({
        time: tsOf(b.date) as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? UP_SOFT : DOWN_SOFT,
      })),
    );
    seriesRef.current.push(vol);

    chart.panes().forEach((p, i) => {
      try {
        p.setStretchFactor(i === 0 ? 0.76 : 0.24);
      } catch {
        /* 版本不支持就用默认分配 */
      }
    });
    const show = Math.min(120, bars.length);
    chart.timeScale().setVisibleLogicalRange({ from: bars.length - show - 0.5, to: bars.length + 1.5 });
  }, [period, bars, points, date, prevClose]);

  const name = q?.name || info.label;
  const code = info.symbol.slice(2);

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="index-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="im-head">
          <span className="im-name">{name}</span>
          <span className="im-code num">{code}</span>
          <span className={`im-price num ${cls(q?.changePct ?? 0)}`}>
            {q ? fmtNum(q.price, 2) : '--'}
          </span>
          <span className={`im-pct num ${cls(q?.changePct ?? 0)}`}>
            {q ? fmtPct(q.changePct) : ''}
          </span>
          <span className="im-tag">{info.full}</span>
          <button
            className="im-stocks"
            // 「成分股」算下一层：记住这个弹窗，列表页按 Esc / 返回图表就弹回来
            onClick={() => gotoMarketFromIndex(info)}
            title={`查看${info.full}全部股票（Esc 返回本页）`}
          >
            成分股 →
          </button>
          <button className="bm-close" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>

        <div className="im-periods">
          {PERIODS.map((p) => (
            <span
              key={p.key}
              className={`im-tab${period === p.key ? ' active' : ''}`}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </span>
          ))}
          <span className="im-tip">
            {period === 'minute' ? `${date || '—'} 分时` : '指数 K 线，可滚轮缩放'}
          </span>
        </div>

        <div className="im-chart" ref={hostRef}>
          {loading && <div className="bm-chart-loading">加载中…</div>}
          {!loading && error && <div className="bm-chart-loading">加载失败：{error}</div>}
          {!loading && !error && period === 'minute' && !points.length && (
            <div className="bm-chart-loading">暂无分时数据</div>
          )}
          {!loading && !error && period !== 'minute' && !bars.length && (
            <div className="bm-chart-loading">暂无数据</div>
          )}
        </div>
      </div>
    </div>
  );
}
