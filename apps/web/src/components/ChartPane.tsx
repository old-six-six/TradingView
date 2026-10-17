import { useEffect, useMemo, useRef, useState } from 'react';
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
import { api, type Bar, type BoardKind, type IndicatorSeries, type MinutePoint, type StockBoard } from '../api';
import { useStore } from '../store';
import { cls, fmtAmount, fmtNum, fmtPct, fmtVolume } from '../fmt';
import BoardModal, { type BoardRef } from './BoardModal';

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

/** 各周期一屏默认显示的 K 线根数，取同花顺的观感 */
const BARS_ON_SCREEN: Record<string, number> = {
  m5: 240,
  m15: 176,
  m30: 128,
  m60: 96,
  day: 150,
  week: 140,
  month: 120,
};

const SUB_INDICATORS = ['MACD', 'KDJ', 'RSI'] as const;
type SubIndicator = (typeof SUB_INDICATORS)[number];
/** 副图最多 3 个，正好对应 3 种可选指标 */
const MAX_SUB_PANES = SUB_INDICATORS.length;
const SUB_STORE_KEY = 'tv.subPanes';

/** 读取副图配置：数组长度即副图个数，空数组表示不显示副图 */
function loadSubPanes(): SubIndicator[] {
  try {
    const raw = localStorage.getItem(SUB_STORE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (
        Array.isArray(arr) &&
        arr.length <= MAX_SUB_PANES &&
        arr.every((x) => SUB_INDICATORS.includes(x))
      ) {
        return arr as SubIndicator[];
      }
    }
  } catch {
    /* 忽略损坏的本地配置 */
  }
  return ['MACD'];
}

const UP = '#d93026';
const DOWN = '#12894f';
const UP_SOFT = 'rgba(217,48,38,0.55)';
const DOWN_SOFT = 'rgba(18,137,79,0.55)';

const MA_COLORS = ['#c98a12', '#1f6feb', '#8b5cf6', '#6b7280'];
const MA_LABELS = ['MA5', 'MA10', 'MA20', 'MA60'] as const;
const MA_STORE_KEY = 'tv.maVisible';

/** 主图指标为单选：同一时间只挂一个，剩下的位置留给 K 线 */
const MAIN_INDICATORS = ['MA', 'BOLL'] as const;
type MainIndicator = (typeof MAIN_INDICATORS)[number];
/** null 表示主图不显示任何指标，只留 K 线与成交量 */
type MainKind = MainIndicator | null;
const MAIN_LABELS: Record<MainIndicator, string> = { MA: '均线', BOLL: 'BOLL' };
const MAIN_STORE_KEY = 'tv.mainInd';
/** 布林带取洋红/青，和四条均线的金蓝紫灰拉开距离 */
const BOLL_COLORS = ['#e11d8f', '#0d9488', '#e11d8f'];

function loadMainKind(): MainKind {
  try {
    const raw = localStorage.getItem(MAIN_STORE_KEY);
    if (raw === null) return 'MA';
    const v = JSON.parse(raw);
    if (v === null || v === 'MA' || v === 'BOLL') return v as MainKind;
    // 兼容旧版多选格式 { MA: boolean, BOLL: boolean }
    if (v && typeof v === 'object') {
      if (v.BOLL) return 'BOLL';
      if (v.MA) return 'MA';
      return null;
    }
  } catch {
    /* 忽略损坏的本地配置 */
  }
  return 'MA';
}

function loadMaVisible(): boolean[] {
  try {
    const raw = localStorage.getItem(MA_STORE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length === MA_LABELS.length) return arr.map(Boolean);
    }
  } catch {
    /* 忽略损坏的本地配置 */
  }
  return MA_LABELS.map(() => true);
}

/** 量柱坐标轴用中文单位，同花顺习惯「万手」而非 K */
const VOLUME_FORMAT = {
  type: 'custom' as const,
  formatter: (v: number) => {
    if (!Number.isFinite(v)) return '';
    if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
    return v.toFixed(0);
  },
  minMove: 1,
};

function toTs(dateStr: string): number {
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

function minuteTs(date: string, hhmm: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, hh, mm) / 1000;
}

/** 时间轴刻度：按跨度自动分层，分钟级别显示 HH:MM，跨日显示 MM/DD */
function makeTickFormatter() {
  return (time: any, tickMarkType?: number): string => {
    if (typeof time !== 'number') return '';
    const d = new Date(time * 1000);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const da = d.getUTCDate();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    // TickMarkType: 0=Year 1=Month 2=DayOfMonth 3=Time 4=TimeWithSeconds
    if (tickMarkType === 0) return `${y}`;
    if (tickMarkType === 1) return `${mo}月`;
    if (tickMarkType === 2) return `${mo}/${da}`;
    return `${hh}:${mi}`;
  };
}

export default function ChartPane() {
  const { selected, period, setPeriod, quotes, items } = useStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<any>[]>([]);

  const barsRef = useRef<Bar[]>([]);
  const indRef = useRef<IndicatorSeries | null>(null);
  const timeIdxRef = useRef<Map<number, number>>(new Map());
  /** 记住当前视图范围，重绘（切均线、切副图）时据此还原，不跳回最新 */
  const viewRef = useRef<{ key: string; range: { from: number; to: number } | null }>({
    key: '',
    range: null,
  });

  /** 副图指标列表：索引即副图序号，长度即副图个数 */
  const [subPanes, setSubPanes] = useState<SubIndicator[]>(loadSubPanes);
  const [indOpen, setIndOpen] = useState(false);
  const indPopRef = useRef<HTMLSpanElement>(null);
  /** 四条均线的显示开关，顺序对应 MA5/10/20/60 */
  const [maVisible, setMaVisible] = useState<boolean[]>(loadMaVisible);
  /** 主图指标：单选，null = 不显示 */
  const [mainKind, setMainKind] = useState<MainKind>(loadMainKind);
  const [mainOpen, setMainOpen] = useState(false);
  const mainPopRef = useRef<HTMLSpanElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [bars, setBars] = useState<Bar[]>([]);
  const [ind, setInd] = useState<IndicatorSeries | null>(null);
  const [minute, setMinute] = useState<{ date: string; prevClose: number; points: MinutePoint[] } | null>(
    null,
  );
  const [lastDate, setLastDate] = useState('');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  /** 该股所属板块；ready=false 表示服务端索引还在建 */
  const [boards, setBoards] = useState<StockBoard[]>([]);
  const [boardReady, setBoardReady] = useState(true);
  const [boardSync, setBoardSync] = useState<{ running: boolean; done: number; total: number } | null>(
    null,
  );
  const [boardExpanded, setBoardExpanded] = useState(false);
  /** 东财有、腾讯无同名板块的标签，是纯文字不可点（科创/北交所才有） */
  const [boardTags, setBoardTags] = useState<string[]>([]);
  const [activeBoard, setActiveBoard] = useState<BoardRef | null>(null);
  const [paneTops, setPaneTops] = useState<number[]>([]);
  const paneRoRef = useRef<ResizeObserver | null>(null);
  const observedElsRef = useRef<Array<HTMLElement | null>>([]);

  const q = quotes[selected];
  const name = q?.name || items.find((i) => i.symbol === selected)?.name || '';

  useEffect(() => {
    if (!selected) {
      setBoards([]);
      setBoardTags([]);
      return;
    }
    let alive = true;
    setBoards([]);
    setBoardTags([]);
    setBoardExpanded(false);
    api
      .stockBoards(selected)
      .then((r) => {
        if (!alive) return;
        setBoards(r.boards);
        setBoardReady(r.ready);
        setBoardSync(r.sync ?? null);
        setBoardTags(r.tags ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selected]);

  /** 服务端板块索引还在建时，隔几秒补拉一次，建好自动出结果 */
  useEffect(() => {
    if (boardReady || !selected) return;
    const t = window.setInterval(() => {
      api
        .stockBoards(selected)
        .then((r) => {
          setBoards(r.boards);
          setBoardReady(r.ready);
          setBoardSync(r.sync ?? null);
          setBoardTags(r.tags ?? []);
        })
        .catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(t);
  }, [boardReady, selected]);

  const industryBoards = boards.filter((b) => b.kind === 'hy');
  /** 概念在前、地域板块垫后，符合同花顺的阅读顺序 */
  const themeBoards = boards
    .filter((b) => b.kind !== 'hy')
    .sort((a, b) => (a.kind === 'dy' ? 1 : 0) - (b.kind === 'dy' ? 1 : 0));
  const THEME_LIMIT = 10;
  /** 纯标签默认只露 6 个，展开后全给 */
  const TAG_LIMIT = 6;
  const shownThemes = boardExpanded ? themeBoards : themeBoards.slice(0, THEME_LIMIT);

  useEffect(() => {
    try {
      localStorage.setItem(MA_STORE_KEY, JSON.stringify(maVisible));
    } catch {
      /* 忽略隐私模式下的写入失败 */
    }
  }, [maVisible]);

  useEffect(() => {
    try {
      localStorage.setItem(MAIN_STORE_KEY, JSON.stringify(mainKind));
    } catch {
      /* 忽略隐私模式下的写入失败 */
    }
  }, [mainKind]);

  useEffect(() => {
    try {
      localStorage.setItem(SUB_STORE_KEY, JSON.stringify(subPanes));
    } catch {
      /* 忽略隐私模式下的写入失败 */
    }
  }, [subPanes]);

  /** 点击面板外或按 Esc 收起折叠面板（主图、副图共用一套收起逻辑） */
  const anyPopOpen = indOpen || mainOpen;
  useEffect(() => {
    if (!anyPopOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!indPopRef.current?.contains(t)) setIndOpen(false);
      if (!mainPopRef.current?.contains(t)) setMainOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setIndOpen(false);
      setMainOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anyPopOpen]);

  /** 设置副图个数：减少直接截断，增加时优先补上还没用到的指标 */
  const setSubCount = (n: number) =>
    setSubPanes((prev) => {
      const want = Math.max(0, Math.min(MAX_SUB_PANES, n));
      if (want === prev.length) return prev;
      if (want < prev.length) return prev.slice(0, want);
      const next = [...prev];
      for (const k of SUB_INDICATORS) {
        if (next.length >= want) break;
        if (!next.includes(k)) next.push(k);
      }
      return next;
    });

  /** 指定副图换成某个指标；若该指标已在别的副图，则两者对调，避免重复 */
  const setPaneAt = (i: number, key: SubIndicator) =>
    setSubPanes((prev) => {
      if (prev[i] === key) return prev;
      const j = prev.indexOf(key);
      const next = [...prev];
      if (j >= 0) next[j] = prev[i];
      next[i] = key;
      return next;
    });

  /** 单条均线开关 */
  const toggleMa = (i: number) =>
    setMaVisible((prev) => prev.map((v, idx) => (idx === i ? !v : v)));
  /** 整组开关：只要还有一条开着就全关，全关时全开 */
  const toggleAllMa = () =>
    setMaVisible((prev) => {
      const next = !prev.some(Boolean);
      return prev.map(() => next);
    });
  const maAllOff = !maVisible.some(Boolean);

  /** 选一个主图指标；再点一次同一个等于关掉（主图只留 K 线） */
  const pickMain = (k: MainIndicator) => setMainKind((prev) => (prev === k ? null : k));

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
      timeScale: {
        borderColor: '#e3e6ea',
        timeVisible: false,
        rightOffset: 4,
        barSpacing: 8,
        // 两侧都钳住数据边界：拖出空白区后滚轮缩放的锚点下没有 K 线，
        // 缩放会静默失效。fixLeftEdge 让第一根贴左，fixRightEdge 让最新一根贴右
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: makeTickFormatter(),
      },
      crosshair: {
        mode: 1,
        vertLine: { color: '#b0b6bd', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#5b6169' },
        horzLine: { color: '#b0b6bd', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#5b6169' },
      },
      localization: {
        timeFormatter: (time: any) => {
          if (typeof time !== 'number') {
            if (time?.year) {
              const mo = String(time.month).padStart(2, '0');
              const da = String(time.day).padStart(2, '0');
              return `${time.year}-${mo}-${da}`;
            }
            return '';
          }
          const d = new Date(time * 1000);
          const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
          const da = String(d.getUTCDate()).padStart(2, '0');
          const hh = String(d.getUTCHours()).padStart(2, '0');
          const mi = String(d.getUTCMinutes()).padStart(2, '0');
          if (hh === '00' && mi === '00') return `${mo}-${da}`;
          return `${mo}-${da} ${hh}:${mi}`;
        },
      },
    });
    chartRef.current = chart;

    // 十字光标联动图例
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || typeof param.time !== 'number') {
        setHoverIdx(null);
        return;
      }
      const idx = timeIdxRef.current.get(param.time as number);
      setHoverIdx(idx === undefined ? null : idx);
    });

    // 记录用户当前的缩放/平移位置
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) viewRef.current.range = { from: range.from, to: range.to };
    });

    const ro = new ResizeObserver(() => {
      if (hostRef.current) {
        chart.applyOptions({
          width: hostRef.current.clientWidth,
          height: hostRef.current.clientHeight,
        });
        layoutPanes();
        requestAnimationFrame(measurePaneTops);
      }
    });
    ro.observe(hostRef.current);

    // 拖动窗格分隔条时高度会变，副图图例要跟着走
    paneRoRef.current = new ResizeObserver(() => {
      requestAnimationFrame(measurePaneTops);
    });

    return () => {
      ro.disconnect();
      paneRoRef.current?.disconnect();
      paneRoRef.current = null;
      observedElsRef.current = [];
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  function layoutPanes() {
    const chart = chartRef.current;
    if (!chart) return;
    const panes = chart.panes();
    // 窗格数由数据决定：主图 + 成交量 + N 个副图，故不能依赖渲染闭包里的 subPanes
    const subCount = Math.max(0, panes.length - 2);
    // 副图越多，主图让一点空间，但保证副图至少留出能看清形态的高度
    const main = subCount >= 3 ? 0.48 : subCount === 2 ? 0.52 : 0.55;
    const vol = 0.14;
    const factors =
      panes.length <= 2
        ? [0.74, 0.26]
        : [main, vol, ...Array.from({ length: subCount }, () => (1 - main - vol) / subCount)];
    panes.forEach((p, i) => {
      try {
        p.setStretchFactor(factors[i] ?? 0.2);
      } catch {
        /* 版本不支持则用默认分配 */
      }
    });
  }

  /** 各窗格顶部相对图表容器的偏移，用于把副图图例摆到自己的窗格里 */
  function measurePaneTops() {
    const chart = chartRef.current;
    const host = hostRef.current;
    if (!chart || !host) return;
    const hostTop = host.getBoundingClientRect().top;
    const panes = chart.panes();
    const tops = panes.map((p) => {
      const el = p.getHTMLElement();
      return el ? Math.max(0, Math.round(el.getBoundingClientRect().top - hostTop)) : 0;
    });
    setPaneTops((prev) =>
      prev.length === tops.length && prev.every((v, i) => v === tops[i]) ? prev : tops,
    );
    // 窗格元素变了才重挂监听：observe 会立即回调一次，反复重挂会形成死循环
    const ro = paneRoRef.current;
    const els = panes.map((p) => p.getHTMLElement());
    const changed =
      els.length !== observedElsRef.current.length ||
      els.some((el, i) => el !== observedElsRef.current[i]);
    if (ro && changed) {
      ro.disconnect();
      els.forEach((el) => {
        if (el) ro.observe(el);
      });
      observedElsRef.current = els;
    }
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
    setHoverIdx(null);

    const load = async () => {
      try {
        if (period === 'minute') {
          const r = await api.minute(selected);
          if (!alive) return;
          // 同花顺口径：分时只画到 15:00，尾部盘后零星成交不入图
          const points = r.points.filter((p) => p.time <= '15:00');
          setMinute({ ...r, points });
          setBars([]);
          setInd(null);
          setLastDate(r.date);
        } else {
          const isDaily = period === 'day' || period === 'week' || period === 'month';
          // 日/周/月取全量历史（日 K 自上市以来，最长的票约 8500 根）
          const k = await api.kline(selected, period, isDaily ? 'all' : 1023);
          if (!alive) return;
          setBars(k.bars);
          setMinute(null);
          setLastDate(k.date ?? k.bars[k.bars.length - 1]?.date ?? '');
          if (k.series) {
            // 分钟周期由服务端随 K 线一起算好
            setInd(k.series);
          } else if (isDaily) {
            const i = await api.indicators(selected, 'all').catch(() => null);
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
    barsRef.current = bars;
    indRef.current = ind;
  }, [bars, ind]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // 必须在清空序列之前取：setData 期间图表会回调可见范围，把记录值冲掉
    const viewKey = `${selected}|${period}`;
    const savedRange = viewRef.current.key === viewKey ? viewRef.current.range : null;
    clearSeries();
    if (!selected) return;

    const isIntraday = period.startsWith('m') && period !== 'minute';

    chart.applyOptions({
      timeScale: {
        timeVisible: period === 'minute' || isIntraday,
        secondsVisible: false,
      },
      rightPriceScale: { scaleMargins: { top: 0.06, bottom: 0.06 } },
    });

    if (period === 'minute' && minute) {
      renderMinute(chart, minute);
    } else if (bars.length) {
      renderKline(chart, bars, ind, { kind: mainKind, ma: maVisible });
    }

    window.setTimeout(() => {
      layoutPanes();
      requestAnimationFrame(measurePaneTops);
      if (period === 'minute') {
        chart.timeScale().fitContent();
      } else {
        const total = bars.length;
        // 同一只票同一周期重绘（切均线/副图）时保留原视野，否则回到最新一屏
        if (savedRange && savedRange.to <= total + 2) {
          chart.timeScale().setVisibleLogicalRange(savedRange);
        } else if (total > 0) {
          const show = Math.min(BARS_ON_SCREEN[period] ?? 150, total);
          chart.timeScale().setVisibleLogicalRange({ from: total - show - 0.5, to: total + 1.5 });
        }
      }
      viewRef.current.key = viewKey;
    }, 0);
  }, [bars, ind, minute, period, subPanes, selected, maVisible, mainKind]);

  /** 光标所在 bar（无光标时取最后一根），供图例显示 */
  const legend = useMemo(() => {
    const list = bars;
    if (!list.length) return null;
    const idx = hoverIdx !== null && hoverIdx >= 0 && hoverIdx < list.length ? hoverIdx : list.length - 1;
    const b = list[idx];
    if (!b) return null;
    const prevClose = idx > 0 ? list[idx - 1].close : b.open;
    const chg = b.close - prevClose;
    const pct = prevClose ? (chg / prevClose) * 100 : 0;
    const s = ind;
    const at = (arr?: number[]) => (arr && Number.isFinite(arr[idx]) ? arr[idx] : null);
    return {
      b,
      chg,
      pct,
      ma: s
        ? [at(s.ma5), at(s.ma10), at(s.ma20), at(s.ma60)]
        : [null, null, null, null],
      boll: s
        ? [at(s.bollUp), at(s.bollMid), at(s.bollDn)]
        : [null, null, null],
      sub: s
        ? {
            dif: at(s.macdDif),
            dea: at(s.macdDea),
            hist: at(s.macdHist),
            k: at(s.kdjK),
            d: at(s.kdjD),
            j: at(s.kdjJ),
            r6: at(s.rsi6),
            r12: at(s.rsi12),
          }
        : null,
      hovered: hoverIdx !== null,
    };
  }, [bars, ind, hoverIdx]);

  /** 分时图例：光标处的价格、均价、涨跌幅、成交量 */
  const minuteLegend = useMemo(() => {
    if (!minute || !minute.points.length) return null;
    const pts = minute.points;
    let idx: number;
    if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < pts.length) {
      idx = hoverIdx;
    } else {
      // 收盘后尾部会有量为 0 的占位点，默认停在最后一根有成交的分钟上
      idx = pts.length - 1;
      for (let i = pts.length - 1; i >= 0; i--) {
        if (pts[i].volume > 0) {
          idx = i;
          break;
        }
      }
    }
    const p = pts[idx];
    if (!p) return null;
    let cumVol = 0;
    let cumAmt = 0;
    for (let i = 0; i <= idx; i++) {
      cumVol += pts[i].volume;
      cumAmt += pts[i].amount;
    }
    const avg = cumVol > 0 ? cumAmt / (cumVol * 100) : p.price;
    const pc = minute.prevClose || p.price;
    return {
      time: p.time,
      price: p.price,
      avg,
      chg: p.price - pc,
      pct: pc ? ((p.price - pc) / pc) * 100 : 0,
      volume: p.volume,
      hovered: hoverIdx !== null,
    };
  }, [minute, hoverIdx]);

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

    // 同花顺口径：分时价格轴以昨收为中轴、上下等幅，避免被单边行情撑歪
    const hi = Math.max(...data.points.map((p) => p.price), data.prevClose || 0);
    const lo = Math.min(...data.points.map((p) => p.price), data.prevClose || Infinity);
    const span = Math.max(hi - (data.prevClose || hi), (data.prevClose || lo) - lo);
    const pad = (span > 0 ? span : (hi - lo) * 0.5 || 0.1) * 1.08;
    const symmetricScale = () =>
      data.prevClose > 0
        ? { priceRange: { minValue: data.prevClose - pad, maxValue: data.prevClose + pad } }
        : null;

    const area = chart.addSeries(AreaSeries, {
      lineColor: mainColor,
      topColor: isUp ? 'rgba(217,48,38,0.16)' : 'rgba(18,137,79,0.16)',
      bottomColor: 'rgba(255,255,255,0)',
      lineWidth: 1,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      priceLineVisible: false,
      lastValueVisible: true,
      autoscaleInfoProvider: symmetricScale,
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
      { priceFormat: VOLUME_FORMAT, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    vol.setData(
      data.points.map((p) => ({
        time: minuteTs(data.date, p.time) as UTCTimestamp,
        value: p.volume,
        color: p.price >= (data.prevClose || p.price) ? UP_SOFT : DOWN_SOFT,
      })),
    );
    seriesRef.current.push(vol);

    // 光标定位索引表（分时同样支持图例联动）
    const idxMap = new Map<number, number>();
    data.points.forEach((p, i) => idxMap.set(minuteTs(data.date, p.time), i));
    timeIdxRef.current = idxMap;

    chart.applyOptions({
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { scaleMargins: { top: 0.02, bottom: 0.02 } },
    });
  }

  function renderKline(
    chart: IChartApi,
    list: Bar[],
    indicators: IndicatorSeries | null,
    main: { kind: MainKind; ma: boolean[] },
  ) {
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

    // 光标定位索引表
    const idxMap = new Map<number, number>();
    list.forEach((b, i) => idxMap.set(toTs(b.date), i));
    timeIdxRef.current = idxMap;

    if (indicators) {
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
        for (let i = 0; i < values.length && i < list.length; i++) {
          const v = values[i];
          if (!Number.isFinite(v)) continue;
          pts.push({ time: toTs(list[i].date) as UTCTimestamp, value: v });
        }
        s.setData(pts);
        seriesRef.current.push(s);
        return s;
      };
      if (main.kind === 'MA') {
        const maSeries = [indicators.ma5, indicators.ma10, indicators.ma20, indicators.ma60];
        maSeries.forEach((vals, i) => {
          if (main.ma[i]) line(vals, MA_COLORS[i]);
        });
      } else if (main.kind === 'BOLL') {
        // 上轨/中轨/下轨；中轨即 20 日均线，故关掉均线也能单独显示
        line(indicators.bollUp, BOLL_COLORS[0]);
        line(indicators.bollMid, BOLL_COLORS[1]);
        line(indicators.bollDn, BOLL_COLORS[2]);
      }
    }

    const vol = chart.addSeries(
      HistogramSeries,
      { priceFormat: VOLUME_FORMAT, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    vol.setData(
      list.map((b) => ({
        time: toTs(b.date) as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? UP_SOFT : DOWN_SOFT,
      })),
    );
    seriesRef.current.push(vol);

    if (indicators) {
      // 每个副图一个独立窗格：主图 0、成交量 1、副图从 2 起
      subPanes.forEach((key, i) => renderSub(chart, indicators, list, 2 + i, key));
    }
  }

  function renderSub(
    chart: IChartApi,
    s: IndicatorSeries,
    list: Bar[],
    paneIndex: number,
    kind: SubIndicator,
  ) {
    const mk = (values: number[], color: string) => {
      const ser = chart.addSeries(
        LineSeries,
        {
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        },
        paneIndex,
      );
      const pts: Array<{ time: UTCTimestamp; value: number }> = [];
      for (let i = 0; i < values.length && i < list.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        pts.push({ time: toTs(list[i].date) as UTCTimestamp, value: v });
      }
      ser.setData(pts);
      seriesRef.current.push(ser);
      return ser;
    };

    if (kind === 'MACD') {
      const hist = chart.addSeries(
        HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false },
        paneIndex,
      );
      const pts: Array<{ time: UTCTimestamp; value: number; color: string }> = [];
      for (let i = 0; i < s.macdHist.length && i < list.length; i++) {
        const v = s.macdHist[i];
        if (!Number.isFinite(v)) continue;
        pts.push({
          time: toTs(list[i].date) as UTCTimestamp,
          value: v,
          color: v >= 0 ? UP_SOFT : DOWN_SOFT,
        });
      }
      hist.setData(pts);
      seriesRef.current.push(hist);
      mk(s.macdDif, MA_COLORS[0]);
      mk(s.macdDea, MA_COLORS[1]);
    } else if (kind === 'KDJ') {
      mk(s.kdjK, MA_COLORS[0]);
      mk(s.kdjD, MA_COLORS[1]);
      mk(s.kdjJ, MA_COLORS[2]);
    } else {
      mk(s.rsi6, MA_COLORS[0]);
      mk(s.rsi12, MA_COLORS[1]);
    }
  }

  const isMinute = period === 'minute';
  const showMa = !isMinute && !!legend && mainKind === 'MA';
  const showBoll = !isMinute && !!legend && mainKind === 'BOLL';

  return (
    <div className="chart-col">
      <div className="quote-head">
        <div className="quote-title">
          <div className="quote-id">
            <span className="quote-name">{name || '--'}</span>
            <span className="quote-code">{selected ? selected.slice(2) : ''}</span>
            <span className={`quote-price num ${cls(q?.changePct)}`}>
              {q ? fmtNum(q.price) : '--'}
            </span>
            <span className={`quote-chg num ${cls(q?.changePct)}`}>
              {q ? `${q.change > 0 ? '+' : ''}${fmtNum(q.change)} ${fmtPct(q.changePct)}` : ''}
            </span>
          </div>
          {q && (
            <div className="quote-stats">
              <div className="qs-row">
                <span className="qs">
                  <i>今开</i>
                  <b className={`num ${cls(q.open - q.prevClose)}`}>{fmtNum(q.open)}</b>
                </span>
                <span className="qs">
                  <i>昨收</i>
                  <b className="num">{fmtNum(q.prevClose)}</b>
                </span>
                <span className="qs">
                  <i>最高</i>
                  <b className={`num ${cls(q.high - q.prevClose)}`}>{fmtNum(q.high)}</b>
                </span>
                <span className="qs">
                  <i>最低</i>
                  <b className={`num ${cls(q.low - q.prevClose)}`}>{fmtNum(q.low)}</b>
                </span>
                <span className="qs">
                  <i>涨停</i>
                  <b className="num up">{fmtNum(q.limitUp)}</b>
                </span>
                <span className="qs">
                  <i>跌停</i>
                  <b className="num down">{fmtNum(q.limitDown)}</b>
                </span>
                <span className="qs">
                  <i>成交量</i>
                  <b className="num">{fmtVolume(q.volume)}</b>
                </span>
                <span className="qs">
                  <i>成交额</i>
                  <b className="num">{fmtAmount(q.amount)}</b>
                </span>
              </div>
              <div className="qs-row">
                <span className="qs">
                  <i>换手</i>
                  <b className="num">{fmtNum(q.turnoverRate)}%</b>
                </span>
                <span className="qs">
                  <i>量比</i>
                  <b className="num">{fmtNum(q.volumeRatio)}</b>
                </span>
                <span className="qs">
                  <i>振幅</i>
                  <b className="num">{fmtNum(q.amplitude)}%</b>
                </span>
                <span className="qs">
                  <i>均价</i>
                  <b className="num">{fmtNum(q.avgPrice)}</b>
                </span>
                <span className="qs">
                  <i>市盈</i>
                  <b className="num">{q.pe ? fmtNum(q.pe) : '--'}</b>
                </span>
                <span className="qs">
                  <i>市净</i>
                  <b className="num">{q.pb ? fmtNum(q.pb) : '--'}</b>
                </span>
                <span className="qs">
                  <i>总市值</i>
                  <b className="num">{fmtAmount(q.marketCap)}</b>
                </span>
                <span className="qs">
                  <i>流通值</i>
                  <b className="num">{fmtAmount(q.floatCap)}</b>
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="board-row">
          {boards.length > 0 && industryBoards.length > 0 && (
            <>
              <span className="board-key">所属行业</span>
              {industryBoards.map((b) => (
                <span
                  key={b.code}
                  className="board-chip"
                  onClick={() => setActiveBoard({ code: b.code, name: b.name, kind: b.kind, changePct: b.changePct })}
                  title={`${b.name}　点击查看板块K线与成分股`}
                >
                  {b.name}
                  <b className={`num ${cls(b.changePct)}`}>{fmtPct(b.changePct)}</b>
                </span>
              ))}
            </>
          )}
          {boards.length > 0 && themeBoards.length > 0 && (
            <>
              <span className="board-key">概念</span>
              {shownThemes.map((b) => (
                <span
                  key={b.code}
                  className="board-chip"
                  onClick={() => setActiveBoard({ code: b.code, name: b.name, kind: b.kind, changePct: b.changePct })}
                  title={`${b.name}　点击查看板块K线与成分股`}
                >
                  {b.name}
                  <b className={`num ${cls(b.changePct)}`}>{fmtPct(b.changePct)}</b>
                </span>
              ))}
              {themeBoards.length > THEME_LIMIT && (
                <span className="board-more" onClick={() => setBoardExpanded((v) => !v)}>
                  {boardExpanded ? '收起 ▴' : `+${themeBoards.length - THEME_LIMIT} 更多 ▾`}
                </span>
              )}
            </>
          )}
          {boardTags.length > 0 && (
            <>
              <span className="board-key">标签</span>
              {(boardExpanded ? boardTags : boardTags.slice(0, TAG_LIMIT)).map((t) => (
                <span
                  key={t}
                  className="board-tag"
                  title={`${t}　东财板块，腾讯无同名板块，暂不提供板块 K 线与成分股`}
                >
                  {t}
                </span>
              ))}
              {boardTags.length > TAG_LIMIT && (
                <span className="board-more" onClick={() => setBoardExpanded((v) => !v)}>
                  {boardExpanded ? '收起 ▴' : `+${boardTags.length - TAG_LIMIT} 更多 ▾`}
                </span>
              )}
            </>
          )}
          {boards.length === 0 && boardTags.length === 0 && (
            <span className="board-empty">
              {boardReady
                ? '暂无板块数据'
                : boardSync && boardSync.total
                  ? `板块索引构建中 ${boardSync.done}/${boardSync.total}…`
                  : '板块索引构建中…'}
            </span>
          )}
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
          <span
            className="period-tab-wrap"
            ref={mainPopRef}
            style={{ visibility: isMinute ? 'hidden' : 'visible' }}
          >
            <span
              className={`period-tab${mainOpen ? ' active' : ''}`}
              onClick={() => {
                setMainOpen((v) => !v);
                setIndOpen(false);
              }}
              title="主图指标设置"
            >
              主图 {mainKind ? MAIN_LABELS[mainKind] : '无'}
              <i className="caret">{mainOpen ? '▴' : '▾'}</i>
            </span>
            {mainOpen && (
              <div className="ind-pop ind-pop-main" onMouseDown={(e) => e.stopPropagation()}>
                <div className="ind-pop-row">
                  <i>指标</i>
                  <div className="ind-chips">
                    {MAIN_INDICATORS.map((k) => (
                      <button
                        key={k}
                        className={mainKind === k ? 'on' : ''}
                        onClick={() => pickMain(k)}
                        title={mainKind === k ? `关闭${MAIN_LABELS[k]}` : `主图只显示${MAIN_LABELS[k]}`}
                      >
                        {MAIN_LABELS[k]}
                      </button>
                    ))}
                    <button
                      className={mainKind === null ? 'on' : ''}
                      onClick={() => setMainKind(null)}
                      title="主图只留 K 线与成交量"
                    >
                      无
                    </button>
                  </div>
                </div>
                <div className="ind-pop-row">
                  <i>周期</i>
                  <div className="ind-chips">
                    {MA_LABELS.map((label, i) => (
                      <button
                        key={label}
                        className={maVisible[i] ? 'on' : ''}
                        disabled={mainKind !== 'MA'}
                        onClick={() => toggleMa(i)}
                        title={`${maVisible[i] ? '隐藏' : '显示'} ${label}`}
                      >
                        {label.replace('MA', '')}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ind-pop-tip">
                  {mainKind === 'MA' ? (
                    <span className="ind-link" onClick={toggleAllMa}>
                      均线{maAllOff ? '全开' : '全关'}
                    </span>
                  ) : mainKind === 'BOLL' ? (
                    '布林带 (20, 2)，中轨即 MA20'
                  ) : (
                    '主图只留 K 线与成交量'
                  )}
                </div>
              </div>
            )}
          </span>
          <span
            className="period-tab-wrap"
            ref={indPopRef}
            style={{ visibility: isMinute ? 'hidden' : 'visible' }}
          >
            <span
              className={`period-tab${indOpen || subPanes.length ? ' active' : ''}`}
              onClick={() => {
                setIndOpen((v) => !v);
                setMainOpen(false);
              }}
              title="副图指标设置"
            >
              指标{subPanes.length ? ` ${subPanes.length}` : ''}
              <i className="caret">{indOpen ? '▴' : '▾'}</i>
            </span>
            {indOpen && (
              <div className="ind-pop" onMouseDown={(e) => e.stopPropagation()}>
                <div className="ind-pop-row">
                  <i>副图数量</i>
                  <div className="ind-counts">
                    {[0, 1, 2, 3].map((n) => (
                      <button
                        key={n}
                        className={n === subPanes.length ? 'on' : ''}
                        onClick={() => setSubCount(n)}
                        title={n === 0 ? '只显示 K 线与成交量' : `${n} 个副图`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                {subPanes.map((key, i) => (
                  <div className="ind-pop-row" key={i}>
                    <i>副图 {i + 1}</i>
                    <select
                      className="ind-select"
                      value={key}
                      onChange={(e) => setPaneAt(i, e.target.value as SubIndicator)}
                    >
                      {SUB_INDICATORS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                {subPanes.length === 0 && <div className="ind-pop-empty">已关闭，只显示 K 线与成交量</div>}
                <div className="ind-pop-tip">选到其他副图在用的指标会两者对调</div>
              </div>
            )}
          </span>
        </span>
      </div>

      <div className="chart-host" ref={hostRef}>
        {loading && <div className="chart-loading">加载中…</div>}
        {!loading && error && <div className="chart-loading">加载失败：{error}</div>}
        {!loading && !error && !bars.length && !minute && <div className="chart-loading">暂无数据</div>}

        {isMinute && minuteLegend && (
          <div className="chart-legend">
            <div className="legend-row">
              <span className="legend-time">{minuteLegend.time}</span>
              <span>
                <i>价</i>
                <b className={`num ${cls(minuteLegend.chg)}`}>{fmtNum(minuteLegend.price)}</b>
              </span>
              <span>
                <i>均</i>
                <b className="num" style={{ color: '#c98a12' }}>
                  {fmtNum(minuteLegend.avg)}
                </b>
              </span>
              <span className={`num ${cls(minuteLegend.chg)}`}>
                {minuteLegend.chg > 0 ? '+' : ''}
                {fmtNum(minuteLegend.chg)} ({minuteLegend.pct > 0 ? '+' : ''}
                {fmtNum(minuteLegend.pct)}%)
              </span>
              <span>
                <i>量</i>
                <b className="num">{fmtVolume(minuteLegend.volume)}</b>
              </span>
            </div>
          </div>
        )}

        {!isMinute && legend && (
          <div className="chart-legend">
            <div className="legend-row">
              <span className="legend-time">{legend.b.date}</span>
              <span>
                <i>开</i>
                <b className={`num ${cls(legend.chg)}`}>{fmtNum(legend.b.open)}</b>
              </span>
              <span>
                <i>高</i>
                <b className={`num ${cls(legend.chg)}`}>{fmtNum(legend.b.high)}</b>
              </span>
              <span>
                <i>低</i>
                <b className={`num ${cls(legend.chg)}`}>{fmtNum(legend.b.low)}</b>
              </span>
              <span>
                <i>收</i>
                <b className={`num ${cls(legend.chg)}`}>{fmtNum(legend.b.close)}</b>
              </span>
              <span className={`num ${cls(legend.chg)}`}>
                {legend.chg > 0 ? '+' : ''}
                {fmtNum(legend.chg)} ({legend.pct > 0 ? '+' : ''}
                {fmtNum(legend.pct)}%)
              </span>
              <span>
                <i>量</i>
                <b className="num">{fmtVolume(legend.b.volume)}</b>
              </span>
            </div>
            {(showMa || showBoll) && (
              <div className="legend-row legend-ma">
                {showMa &&
                  MA_LABELS.map((label, i) => (
                    <span
                      key={label}
                      className={`ma-item${maVisible[i] ? '' : ' off'}`}
                      style={maVisible[i] ? { color: MA_COLORS[i] } : undefined}
                      onClick={() => toggleMa(i)}
                      title={maVisible[i] ? `隐藏 ${label}` : `显示 ${label}`}
                    >
                      {label}{' '}
                      <b className="num">
                        {maVisible[i] && legend.ma[i] !== null ? fmtNum(legend.ma[i] as number) : '--'}
                      </b>
                    </span>
                  ))}
                {showBoll && (
                  <>
                    <span className="legend-tag">BOLL</span>
                    {['UP', 'MB', 'DN'].map((tag, i) => (
                      <span key={tag} style={{ color: BOLL_COLORS[i] }}>
                        {tag} <b className="num">{fmtNum(legend.boll[i])}</b>
                      </span>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* 副图图例各贴在自己的窗格顶部，避免堆在主图上挡住 K 线 */}
        {!isMinute &&
          legend?.sub &&
          subPanes.map((key, i) => (
            <div
              className="chart-legend chart-legend-sub"
              key={key + i}
              style={{ top: (paneTops[2 + i] ?? 4) + 3 }}
            >
              <div className="legend-row legend-ma">
                <span className="legend-tag">{key}</span>
                {key === 'MACD' && (
                  <>
                    <span style={{ color: MA_COLORS[0] }}>
                      DIF <b className="num">{fmtNum(legend.sub!.dif)}</b>
                    </span>
                    <span style={{ color: MA_COLORS[1] }}>
                      DEA <b className="num">{fmtNum(legend.sub!.dea)}</b>
                    </span>
                    <span style={{ color: (legend.sub!.hist ?? 0) >= 0 ? UP : DOWN }}>
                      MACD <b className="num">{fmtNum(legend.sub!.hist)}</b>
                    </span>
                  </>
                )}
                {key === 'KDJ' && (
                  <>
                    <span style={{ color: MA_COLORS[0] }}>
                      K <b className="num">{fmtNum(legend.sub!.k)}</b>
                    </span>
                    <span style={{ color: MA_COLORS[1] }}>
                      D <b className="num">{fmtNum(legend.sub!.d)}</b>
                    </span>
                    <span style={{ color: MA_COLORS[2] }}>
                      J <b className="num">{fmtNum(legend.sub!.j)}</b>
                    </span>
                  </>
                )}
                {key === 'RSI' && (
                  <>
                    <span style={{ color: MA_COLORS[0] }}>
                      RSI6 <b className="num">{fmtNum(legend.sub!.r6)}</b>
                    </span>
                    <span style={{ color: MA_COLORS[1] }}>
                      RSI12 <b className="num">{fmtNum(legend.sub!.r12)}</b>
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}
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
        <span style={{ marginLeft: 'auto' }}>
          {legend ? (legend.hovered ? `光标 ${legend.b.date}` : `最新 ${lastDate}`) : lastDate}
        </span>
      </div>

      {activeBoard && (
        <BoardModal board={activeBoard} onClose={() => setActiveBoard(null)} />
      )}
    </div>
  );
}
