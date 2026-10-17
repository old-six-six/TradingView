import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  AreaSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api, type Bar, type IndicatorSeries, type MinutePoint } from '../api';
import { useStore } from '../store';
import { cls, fmtAmount, fmtNum, fmtPct, fmtVolume } from '../fmt';

const PERIODS: Array<{ key: string; label: string }> = [
  { key: 'minute', label: '分时' },
  { key: 'm5', label: '5分' },
  { key: 'm15', label: '15分' },
  { key: 'm30', label: '30分' },
  { key: 'm60', label: '60分' },
  { key: 'day', label: '日K' },
  { key: 'week', label: '周K' },
  { key: 'month', label: '月K' },
];

const SUB_INDICATORS = ['MACD', 'KDJ', 'RSI'] as const;
type SubIndicator = (typeof SUB_INDICATORS)[number];

const UP = '#d93026';
const DOWN = '#12894f';

function toTs(dateStr: string, fallbackDate?: string): number {
  const m = (dateStr ?? '').trim();
  if (!m) return 0;
  if (m.length <= 10) {
    const [y, mo, d] = m.split('-').map(Number);
    return Date.UTC(y, mo - 1, d) / 1000;
  }
  const [datePart, timePart] = m.split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, hh, mm) / 1000;
}

function minuteTs(date: string, hhmm: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, hh, mm) / 1000;
}

export default function ChartPane() {
  const { selected, period, setPeriod, quotes, items } = useStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<any>[]>([]);
  const [sub, setSub] = useState<SubIndicator>('MACD');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [bars, setBars] = useState<Bar[]>([]);
  const [ind, setInd] = useState<IndicatorSeries | null>(null);
  const [minute, setMinute] = useState<{ date: string; prevClose: number; points: MinutePoint[] } | null>(
    null,
  );
  const [lastDate, setLastDate] = useState('');

  const q = quotes[selected];
  const name = q?.name || items.find((i) => i.symbol === selected)?.name || '';

  useEffect(() => {
    if (!hostRef.current) return;
    const chart = createChart(hostRef.current, {
      layout: {
        background: { color: '#ffffff' },
        textColor: '#5b6169',
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: '#e3e6ea', separatorHoverColor: '#d0d5db', enableResize: true },
      },
      grid: {
        vertLines: { color: '#f2f3f5' },
        horzLines: { color: '#f2f3f5' },
      },
      rightPriceScale: { borderColor: '#e3e6ea', scaleMargins: { top: 0.06, bottom: 0.06 } },
      timeScale: { borderColor: '#e3e6ea', timeVisible: false, rightOffset: 3, barSpacing: 8 },
      crosshair: {
        mode: 1,
        vertLine: { color: '#b0b6bd', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#5b6169' },
        horzLine: { color: '#b0b6bd', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#5b6169' },
      },
      localization: {
        timeFormatter: (time: any) => {
          const t = typeof time === 'number' ? time : null;
          if (t === null) {
            if (time?.year) return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
            return '';
          }
          const d = new Date(t * 1000);
          const y = d.getUTCFullYear();
          const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
          const da = String(d.getUTCDate()).padStart(2, '0');
          const hh = String(d.getUTCHours()).padStart(2, '0');
          const mi = String(d.getUTCMinutes()).padStart(2, '0');
          if (hh === '00' && mi === '00') return `${y}-${mo}-${da}`;
          return `${y}-${mo}-${da} ${hh}:${mi}`;
        },
      },
    });
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (hostRef.current) {
        chart.applyOptions({
          width: hostRef.current.clientWidth,
          height: hostRef.current.clientHeight,
        });
        layoutPanes();
      }
    });
    ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  function layoutPanes() {
    const chart = chartRef.current;
    if (!chart) return;
    const panes = chart.panes();
    const factors = panes.length >= 3 ? [0.56, 0.16, 0.28] : [0.74, 0.26];
    panes.forEach((p, i) => {
      try {
        p.setStretchFactor(factors[i] ?? 0.2);
      } catch {
        /* 版本不支持则用默认分配 */
      }
    });
  }

  function clearSeries() {
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
  }

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setLoading(true);
    setError('');

    const load = async () => {
      try {
        if (period === 'minute') {
          const r = await api.minute(selected);
          if (!alive) return;
          setMinute(r);
          setBars([]);
          setInd(null);
          setLastDate(r.date);
        } else {
          const isDaily = period === 'day' || period === 'week' || period === 'month';
          const k = await api.kline(selected, period, isDaily ? 500 : 400);
          if (!alive) return;
          setBars(k.bars);
          setMinute(null);
          setLastDate(k.date ?? k.bars[k.bars.length - 1]?.date ?? '');
          if (isDaily) {
            const i = await api.indicators(selected, 500).catch(() => null);
            if (!alive) return;
            setInd(i?.series ?? null);
          } else {
            setInd(null);
          }
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    return () => {
      alive = false;
    };
  }, [selected, period]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    clearSeries();
    if (!selected) return;

    if (period === 'minute' && minute) {
      renderMinute(chart, minute);
    } else if (bars.length) {
      renderKline(chart, bars, ind);
    }

    window.setTimeout(() => {
      layoutPanes();
      if (period === 'minute') {
        chart.timeScale().fitContent();
      } else {
        const total = bars.length;
        const show = Math.min(150, total);
        if (total > 0) {
          chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - show), to: total + 1 });
        }
      }
    }, 0);
  }, [bars, ind, minute, period, sub, selected]);

  function renderMinute(
    chart: IChartApi,
    data: { date: string; prevClose: number; points: MinutePoint[] },
  ) {
    const priceData = data.points.map((p) => ({
      time: minuteTs(data.date, p.time) as UTCTimestamp,
      value: p.price,
    }));

    let cumVol = 0;
    let cumAmt = 0;
    const avgData = data.points.map((p) => {
      cumVol += p.volume;
      cumAmt += p.amount;
      return {
        time: minuteTs(data.date, p.time) as UTCTimestamp,
        value: cumVol > 0 ? cumAmt / (cumVol * 100) : p.price,
      };
    });

    const first = data.points[0]?.price ?? data.prevClose;
    const last = data.points[data.points.length - 1]?.price ?? first;
    const isUp = last >= data.prevClose;
    const mainColor = isUp ? UP : DOWN;

    const area = chart.addSeries(AreaSeries, {
      lineColor: mainColor,
      topColor: isUp ? 'rgba(217,48,38,0.16)' : 'rgba(18,137,79,0.16)',
      bottomColor: 'rgba(255,255,255,0)',
      lineWidth: 1,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      priceLineVisible: false,
      lastValueVisible: true,
    });
    area.setData(priceData);
    seriesRef.current.push(area);

    if (data.prevClose) {
      area.createPriceLine({
        price: data.prevClose,
        color: '#8b929b',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '昨收',
      });
    }

    const avg = chart.addSeries(
      LineSeries,
      {
        color: '#c98a12',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      0,
    );
    avg.setData(avgData);
    seriesRef.current.push(avg);

    const vol = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    vol.setData(
      data.points.map((p) => ({
        time: minuteTs(data.date, p.time) as UTCTimestamp,
        value: p.volume,
        color: p.price >= (data.prevClose || p.price) ? 'rgba(217,48,38,0.5)' : 'rgba(18,137,79,0.5)',
      })),
    );
    seriesRef.current.push(vol);

    chart.applyOptions({ timeScale: { timeVisible: true, secondsVisible: false } });
  }

  function renderKline(chart: IChartApi, list: Bar[], indicators: IndicatorSeries | null) {
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
      list.map((b) => ({
        time: toTs(b.date) as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );
    seriesRef.current.push(candles);

    const isIntraday = period.startsWith('m');
    chart.applyOptions({
      timeScale: { timeVisible: isIntraday, secondsVisible: false },
    });

    if (indicators && period === 'day') {
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
        s.setData(
          values
            .map((v, i) => ({ time: toTs(indicators.date[i]) as UTCTimestamp, value: v }))
            .filter((p) => Number.isFinite(p.value) && p.time > 0),
        );
        seriesRef.current.push(s);
        return s;
      };
      line(indicators.ma5, '#c98a12');
      line(indicators.ma10, '#1f6feb');
      line(indicators.ma20, '#8b5cf6');
      line(indicators.ma60, '#6b7280');
    }

    const vol = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    vol.setData(
      list.map((b) => ({
        time: toTs(b.date) as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(217,48,38,0.55)' : 'rgba(18,137,79,0.55)',
      })),
    );
    seriesRef.current.push(vol);

    if (indicators && period === 'day') {
      renderSub(chart, indicators);
    }
  }

  function renderSub(chart: IChartApi, s: IndicatorSeries) {
    const mk = (values: number[], color: string, extra: Record<string, unknown> = {}) => {
      const ser = chart.addSeries(
        LineSeries,
        {
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          ...extra,
        },
        2,
      );
      ser.setData(
        values
          .map((v, i) => ({ time: toTs(s.date[i]) as UTCTimestamp, value: v }))
          .filter((p) => Number.isFinite(p.value) && p.time > 0),
      );
      seriesRef.current.push(ser);
      return ser;
    };

    if (sub === 'MACD') {
      const hist = chart.addSeries(
        HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false },
        2,
      );
      hist.setData(
        s.macdHist
          .map((v, i) => ({
            time: toTs(s.date[i]) as UTCTimestamp,
            value: v,
            color: v >= 0 ? 'rgba(217,48,38,0.6)' : 'rgba(18,137,79,0.6)',
          }))
          .filter((p) => Number.isFinite(p.value) && p.time > 0),
      );
      seriesRef.current.push(hist);
      mk(s.macdDif, '#c98a12');
      mk(s.macdDea, '#1f6feb');
    } else if (sub === 'KDJ') {
      mk(s.kdjK, '#c98a12');
      mk(s.kdjD, '#1f6feb');
      mk(s.kdjJ, '#8b5cf6');
    } else {
      mk(s.rsi6, '#c98a12');
      mk(s.rsi12, '#1f6feb');
    }
  }

  return (
    <div className="chart-col">
      <div className="quote-head">
        <div className="quote-title">
          <span className="quote-name">{name || '--'}</span>
          <span className="quote-code">{selected ? selected.slice(2) : ''}</span>
          <span className={`quote-price num ${cls(q?.changePct)}`}>
            {q ? fmtNum(q.price) : '--'}
          </span>
          <span className={`quote-chg num ${cls(q?.changePct)}`}>
            {q ? `${q.change > 0 ? '+' : ''}${fmtNum(q.change)} ${fmtPct(q.changePct)}` : ''}
          </span>
        </div>
        <div className="quote-meta">
          <span>
            开 <b className={`num ${cls(q ? q.open - q.prevClose : 0)}`}>{q ? fmtNum(q.open) : '--'}</b>
          </span>
          <span>
            高 <b className={`num ${cls(q ? q.high - q.prevClose : 0)}`}>{q ? fmtNum(q.high) : '--'}</b>
          </span>
          <span>
            低 <b className={`num ${cls(q ? q.low - q.prevClose : 0)}`}>{q ? fmtNum(q.low) : '--'}</b>
          </span>
          <span>
            量 <b className="num">{q ? fmtVolume(q.volume) : '--'}</b>
          </span>
          <span>
            额 <b className="num">{q ? fmtAmount(q.amount) : '--'}</b>
          </span>
          <span>
            换手 <b className="num">{q ? `${fmtNum(q.turnoverRate)}%` : '--'}</b>
          </span>
          <span>
            量比 <b className="num">{q ? fmtNum(q.volumeRatio) : '--'}</b>
          </span>
        </div>
      </div>

      <div className="period-bar">
        {PERIODS.map((p) => (
          <span
            key={p.key}
            className={`period-tab${period === p.key ? ' active' : ''}`}
            onClick={() => setPeriod(p.key)}
          >
            {p.label}
          </span>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          {SUB_INDICATORS.map((s) => (
            <span
              key={s}
              className={`period-tab${sub === s ? ' active' : ''}`}
              onClick={() => setSub(s)}
              style={{ visibility: period === 'day' ? 'visible' : 'hidden' }}
            >
              {s}
            </span>
          ))}
        </span>
      </div>

      <div className="chart-host" ref={hostRef}>
        {loading && <div className="chart-loading">加载中…</div>}
        {!loading && error && <div className="chart-loading">加载失败：{error}</div>}
        {!loading && !error && !bars.length && !minute && <div className="chart-loading">暂无数据</div>}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 14,
          padding: '4px 14px 6px',
          fontSize: 11,
          color: 'var(--text-3)',
          borderTop: '1px solid var(--border)',
        }}
      >
        <span style={{ color: '#c98a12', visibility: period === 'minute' ? 'hidden' : 'visible' }}>MA5</span>
        <span style={{ color: '#1f6feb', visibility: period === 'minute' ? 'hidden' : 'visible' }}>MA10</span>
        <span style={{ color: '#8b5cf6', visibility: period === 'minute' ? 'hidden' : 'visible' }}>MA20</span>
        <span style={{ color: '#6b7280', visibility: period === 'minute' ? 'hidden' : 'visible' }}>MA60</span>
        <span style={{ marginLeft: 'auto' }}>{lastDate ? `数据日期 ${lastDate}` : ''}</span>
      </div>
    </div>
  );
}
