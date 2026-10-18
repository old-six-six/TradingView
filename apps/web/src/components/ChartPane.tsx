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
import { calcSupportPressure, type SupportPressure } from '../supportPressure';
import { StickLinesPrimitive } from '../stickLines';
import {
  calcFortune,
  FORTUNE_BOTTOM,
  FORTUNE_MID,
  FORTUNE_TOP,
  type Fortune,
} from '../fortune';
import { BandFillPrimitive } from '../bandFill';
import { useStore } from '../store';
import { cls, fmtAmount, fmtNum, fmtPct, fmtVolume } from '../fmt';
import BoardModal, { type BoardRef } from './BoardModal';
import WatchAddModal from './WatchAddModal';
import PosMenu from './PosMenu';
import BoardMenu from './BoardMenu';
import { watchEntryFolder } from '../sideOrder';
import { MARKET_POS_LABEL } from './MarketPage';

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

const SUB_INDICATORS = ['MACD', 'KDJ', 'RSI', 'CYHT'] as const;
type SubIndicator = (typeof SUB_INDICATORS)[number];
const SUB_LABELS: Record<SubIndicator, string> = {
  MACD: 'MACD',
  KDJ: 'KDJ',
  RSI: 'RSI',
  CYHT: '财运亨通',
};
/** 副图最多 4 个，正好对应 4 种可选指标 */
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
const MAIN_INDICATORS = ['MA', 'BOLL', 'SUP'] as const;
type MainIndicator = (typeof MAIN_INDICATORS)[number];
/** null 表示主图不显示任何指标，只留 K 线与成交量 */
type MainKind = MainIndicator | null;
const MAIN_LABELS: Record<MainIndicator, string> = {
  MA: '均线',
  BOLL: 'BOLL',
  SUP: '支撑压力',
};
const MAIN_STORE_KEY = 'tv.mainInd';
/** 布林带取洋红/青，和四条均线的金蓝紫灰拉开距离 */
const BOLL_COLORS = ['#e11d8f', '#0d9488', '#e11d8f'];
/**
 * 支撑压力（大智慧）配色：原码只指定了铁底线红、成本线绿、价值中枢黄，
 * 其余取白。白线在白底上看不见，风险线改用中性灰，必卖线用橙、底线用蓝，
 * 都和 K 线的红绿拉开距离。
 */
const SUP_COLORS = {
  sell: '#ea580c',
  risk: '#64748b',
  cost: '#059669',
  mid: '#ca8a04',
  floor: '#2563eb',
  iron: '#dc2626',
};
/** 持仓柱（原码默认白色，白底下改成中性灰），减仓柱沿用原码的黄色 */
const SUP_HOLD_COLOR = 'rgba(148,163,184,0.55)';
const SUP_REDUCE_COLOR = 'rgba(240,180,41,0.8)';
/** 竖柱宽度占 K 线间距的比例：比原码的 0.5 再细一点，免得糊住 K 线 */
const SUP_STICK_RATIO = 0.34;
/**
 * 必卖线在成本线 ×1.3、铁底线在 ×0.7，一起参与价格轴自适应会把 K 线压扁，
 * 所以给一个「全部 6 条 / 核心 4 条」的开关，默认按原码画全。
 */
type SupBands = 'all' | 'core';
const SUP_BANDS_KEY = 'tv.supBands';
function loadSupBands(): SupBands {
  try {
    return localStorage.getItem(SUP_BANDS_KEY) === 'core' ? 'core' : 'all';
  } catch {
    return 'all';
  }
}
const SUP_LABELS = [
  { key: 'sell', name: '必卖', color: SUP_COLORS.sell },
  { key: 'risk', name: '风险', color: SUP_COLORS.risk },
  { key: 'cost', name: '成本', color: SUP_COLORS.cost },
  { key: 'mid', name: '中枢', color: SUP_COLORS.mid },
  { key: 'floor', name: '底线', color: SUP_COLORS.floor },
  { key: 'iron', name: '铁底', color: SUP_COLORS.iron },
] as const;
/** 核心 4 条：去掉 1.3× / 0.7× 两条极值带 */
const SUP_CORE_KEYS = new Set(['risk', 'cost', 'mid', 'floor']);

/**
 * 财运亨通（大智慧）配色：原码只给了两处填充色，
 * 黄（FFFF00）盖在 80 之上、蓝（00AAFF）盖在 20 之下，这里都调成半透明，
 * 免得把下面的 SK/SD 线条糊掉。三条水平线取红绿灰，和 K 线涨跌不冲突。
 */
const CYHT_COLORS = {
  sk: '#c98a12',
  sd: '#1f6feb',
  buy: '#12894f',
  sell: '#ea580c',
  top: '#dc2626',
  bottom: '#059669',
  mid: '#94a3b8',
};
const CYHT_FILL_TOP = 'rgba(250,204,21,0.30)';
const CYHT_FILL_BOTTOM = 'rgba(0,170,255,0.22)';

function loadMainKind(): MainKind {
  try {
    const raw = localStorage.getItem(MAIN_STORE_KEY);
    if (raw === null) return 'MA';
    const v = JSON.parse(raw);
    if (v === null || v === 'MA' || v === 'BOLL' || v === 'SUP') return v as MainKind;
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
  const { selected, period, setPeriod, quotes, items, sidebar, toggleSidebar, entry } = useStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<any>[]>([]);
  /** 主图 K 线序列，键盘左右键定位光标时要知道价格轴挂在谁身上 */
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  /** 光标当前所在的 K 线索引，null = 还没定位过 */
  const xhairRef = useRef<number | null>(null);
  /** 光标此刻是否显示在图上（鼠标移开后为 false，但索引留着好接着按方向键） */
  const xhairOn = useRef(false);
  /** 视野跟随光标的 rAF 句柄，连按时只保留最后一次补偿 */
  const followRaf = useRef(0);
  /**
   * 程序化移动光标的静默期（performance.now 时间戳）。
   * 光标被键盘挪到视野外时，图表会把它钳到边缘并按边缘那根回调，
   * 若采信这个回调，索引会倒退一格 —— 连按就变成一格走两根。
   */
  const progUntil = useRef(0);
  /** 上一帧请求的可见范围，用来确认窗口是否已经生效 */
  const pendingRange = useRef<{ from: number; to: number } | null>(null);

  const barsRef = useRef<Bar[]>([]);
  const indRef = useRef<IndicatorSeries | null>(null);
  const timeIdxRef = useRef<Map<number, number>>(new Map());
  /**
   * 记住当前视图范围，重绘（切均线、切副图）时据此还原，不跳回最新。
   * `bars` 存的是渲染时的数据引用：切股票/切周期时数据换了引用，即便
   * 逻辑坐标还在范围内也不能沿用旧视野，否则会停在上一只票那段历史上。
   */
  const viewRef = useRef<{
    key: string;
    bars: Bar[] | null;
    range: { from: number; to: number } | null;
  }>({ key: '', bars: null, range: null });

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
  /** 支撑压力画几条带：默认按原码画全 6 条 */
  const [supBands, setSupBands] = useState<SupBands>(loadSupBands);
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
  /** 「加入自选」弹窗 */
  const [watchOpen, setWatchOpen] = useState(false);
  /** 底部「自选板块」下拉 */
  const [posOpen, setPosOpen] = useState(false);
  /** 底部「沪深京」下拉（五大板块） */
  const [boardOpen, setBoardOpen] = useState(false);
  const paneRoRef = useRef<ResizeObserver | null>(null);
  const observedElsRef = useRef<Array<HTMLElement | null>>([]);

  const q = quotes[selected];
  const name = q?.name || items.find((i) => i.symbol === selected)?.name || '';
  /** 「当前位置」：五大板块用板块简称，自选文件夹用文件夹名 */
  const posFolder = watchEntryFolder(entry);
  const posLabel = entry ? posFolder ?? MARKET_POS_LABEL[entry] ?? null : null;

  /**
   * 支撑压力是纯价格指标（不需要服务端那套指标序列），按当前周期的 K 线现算，
   * 切周/月线时也跟得上；几千根算一遍不到 5ms。
   */
  const sup = useMemo(
    () => (mainKind === 'SUP' && bars.length ? calcSupportPressure(bars) : null),
    [mainKind, bars],
  );

  /**
   * 财运亨通同样是纯 K 线指标，按当前周期现算；只有挂了这块副图才算，
   * 省下没必要的重复计算（三十来根窗口的滚动极值，几千根 1ms 内）。
   */
  const needFortune = subPanes.includes('CYHT');
  const fortune = useMemo(
    () => (needFortune && bars.length ? calcFortune(bars) : null),
    [needFortune, bars],
  );

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
      localStorage.setItem(SUP_BANDS_KEY, supBands);
    } catch {
      /* 忽略隐私模式下的写入失败 */
    }
  }, [supBands]);

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
      if (performance.now() < progUntil.current) return;
      if (!param.time || typeof param.time !== 'number') {
        xhairOn.current = false;
        setHoverIdx(null);
        return;
      }
      const idx = timeIdxRef.current.get(param.time as number);
      if (idx === undefined) {
        xhairOn.current = false;
        setHoverIdx(null);
        return;
      }
      xhairRef.current = idx;
      xhairOn.current = true;
      setHoverIdx(idx);
    });

    // 记录用户当前的缩放/平移位置
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) viewRef.current.range = { from: range.from, to: range.to };
    });

    const ro = new ResizeObserver(() => {
      if (hostRef.current) {
        // 先记下当前光标位置：applyOptions 之后图表会按像素重算十字线并回调，
        // 那时 xhairRef 已经被改掉了
        const keep = xhairOn.current ? xhairRef.current : null;
        chart.applyOptions({
          width: hostRef.current.clientWidth,
          height: hostRef.current.clientHeight,
        });
        layoutPanes();
        requestAnimationFrame(measurePaneTops);
        // 宽度变了十字线会按像素重新吸附到别的 K 线上，重新钉回原来那根
        if (keep !== null) {
          requestAnimationFrame(() => {
            xhairRef.current = keep;
            placeCrosshair(0);
          });
        }
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

  /**
   * 左右方向键挪光标：逐根走，走出视野时把窗口跟着平移一格，
   * 这样一直按住 ← 就能从最新一根一路回看到上市首日。
   * 上下方向键改做缩放（↑ 放大 / ↓ 缩小），换股交给 【 】。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const lr = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      const ud = e.key === 'ArrowUp' || e.key === 'ArrowDown';
      if (!lr && !ud) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 列表页有自己的左右滚动，不抢
      if (useStore.getState().market) return;

      const list = barsRef.current;
      const chart = chartRef.current;
      const candle = candleRef.current;
      if (!list.length || !chart || !candle) return;
      e.preventDefault();

      // ↑ 放大 = 视野变窄；每按一次缩放 20%，手感接近滚轮
      if (ud) {
        zoomBy(e.key === 'ArrowUp' ? 0.8 : 1 / 0.8);
        return;
      }

      const ts = chart.timeScale();
      // 还没定位过就从当前视野右端起算，跟「直接按←」的直觉一致。
      // 用 floor 不用 round：右侧留白会让 range.to 略大于最后一根，
      // round 会算到倒数第二根，第一次按键就跳两格
      const vr = ts.getVisibleLogicalRange();
      const start =
        xhairRef.current ??
        Math.min(list.length - 1, Math.max(0, Math.floor(vr?.to ?? list.length - 1)));
      const next = Math.max(0, Math.min(list.length - 1, start + (e.key === 'ArrowRight' ? 1 : -1)));
      xhairRef.current = next;
      setHoverIdx(next);

      // 等到下一帧再定位：窗口平移是异步生效的，同一帧里读到的还是旧范围
      if (followRaf.current) cancelAnimationFrame(followRaf.current);
      followRaf.current = requestAnimationFrame(() => placeCrosshair(0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * 以十字光标为中心缩放（没有光标就以视野中心），factor < 1 放大。
   * 缩完必须重钉一次光标：十字线是按像素记位置的，视野一变就落到隔壁 K 线。
   */
  function zoomBy(factor: number) {
    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();
    const bars = barsRef.current;
    if (!bars.length) return;
    // 连按时上一次的窗口还没生效，直接读可见范围会把每次按键都算在同一个基点上
    //（连按 20 次只缩一步）。优先用排队中的目标范围叠加。
    const r = pendingRange.current ?? ts.getVisibleLogicalRange();
    if (!r) return;

    const w = r.to - r.from;
    const lo = 0;
    // 右端同样上限就是最后一根：多算的留白图表会钳掉，宽度跟着变，连按就不是等比了
    const hi = bars.length - 1;
    const nw = Math.max(15, Math.min(hi - lo, w * factor));
    if (Math.abs(nw - w) < 0.01) return;

    const i = xhairOn.current ? xhairRef.current : null;
    const center = i ?? (r.from + r.to) / 2;
    let from = center - nw / 2;
    let to = center + nw / 2;
    // 撞到数据边界时整段回推、宽度不变。交给图表钳边会顺手把宽度也改掉，
    // 那样连按的手感就不是等比缩放了
    if (from < lo) {
      from = lo;
      to = lo + nw;
    }
    if (to > hi) {
      to = hi;
      from = hi - nw;
    }

    const nr = { from, to };
    pendingRange.current = nr;
    // 抑制十字线回调：改范围的一瞬间图表会按像素重算光标并回调隔壁那根，
    // 采信之后光标会莫名其妙挪一根
    progUntil.current = performance.now() + 200;
    ts.setVisibleLogicalRange(nr);
    if (i !== null) {
      if (followRaf.current) cancelAnimationFrame(followRaf.current);
      followRaf.current = requestAnimationFrame(() => placeCrosshair(0));
    } else {
      pendingRange.current = null;
    }
  }

  /**
   * 把十字光标钉到 xhairRef 指向的那根 K 线上。
   * 光标落在视野外时图表会把它钳到边缘，而且十字线是按像素记位置的 ——
   * 窗口一平移，同一个像素就落到左边一根去了。所以必须「先挪窗口 →
   * 确认窗口真的生效 → 再定位光标」，否则图例和坐标轴上的日期会差一两根。
   */
  function placeCrosshair(depth: number) {
    followRaf.current = 0;
    const chart = chartRef.current;
    const candle = candleRef.current;
    const list = barsRef.current;
    const i = xhairRef.current;
    if (!chart || !candle || i === null || !list[i]) return;

    const ts = chart.timeScale();
    /**
     * 图表把可见范围右端硬钳到最后一根：再往右要留白会被静默丢掉（实测请求 7651
     * 只得到 7650）。而判断「光标在视野内」时又要多留半格余量，于是走到最后一根
     * 就会不停请求一个永远不生效的平移，光标卡在倒数第二根 —— 按 → 没反应。
     */
    const maxTo = list.length - 1;

    // 上一帧请求的窗口还没生效，继续等
    const want = pendingRange.current;
    if (want) {
      const cur = ts.getVisibleLogicalRange();
      const waiting =
        cur && (Math.abs(cur.from - want.from) > 0.01 || Math.abs(cur.to - want.to) > 0.01);
      if (waiting && depth < 10) {
        followRaf.current = requestAnimationFrame(() => placeCrosshair(depth + 1));
        return;
      }
      pendingRange.current = null;
    }

    const r = ts.getVisibleLogicalRange();
    if (r) {
      const w = r.to - r.from;
      let nr: { from: number; to: number } | null = null;
      if (i < r.from + 0.5) nr = { from: i - 1, to: i - 1 + w };
      else if (i > r.to - 0.5) nr = { from: i + 1 - w, to: i + 1 };
      if (nr) {
        if (nr.to > maxTo) nr = { from: maxTo - w, to: maxTo };
        if (nr.from < 0) nr = { from: 0, to: w };
        // 已经顶到数据边界、窗口挪不动了，就在当前视野里直接落光标，别再空等
        const moved = Math.abs(nr.from - r.from) > 0.01 || Math.abs(nr.to - r.to) > 0.01;
        if (moved) {
          pendingRange.current = nr;
          progUntil.current = performance.now() + 200;
          ts.setVisibleLogicalRange(nr);
          if (depth < 10) {
            followRaf.current = requestAnimationFrame(() => placeCrosshair(depth + 1));
            return;
          }
        }
      }
    }

    progUntil.current = performance.now() + 200;
    chart.setCrosshairPosition(list[i].close, toTs(list[i].date) as UTCTimestamp, candle);
    // 图表不会为程序化定位回调 subscribeCrosshairMove，图例只能自己跟着走
    xhairOn.current = true;
    setHoverIdx(i);
  }

  function layoutPanes() {
    const chart = chartRef.current;
    if (!chart) return;
    const panes = chart.panes();
    // 窗格数由数据决定：主图 + 成交量 + N 个副图，故不能依赖渲染闭包里的 subPanes
    const subCount = Math.max(0, panes.length - 2);
    // 副图越多，主图让一点空间，但保证副图至少留出能看清形态的高度
    const main = subCount >= 4 ? 0.42 : subCount === 3 ? 0.46 : subCount === 2 ? 0.52 : 0.55;
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
    candleRef.current = null;
  }

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setLoading(true);
    setError('');
    setHoverIdx(null);
    // 换票先清空：否则加载期间画布上还挂着上一只票的 K 线，
    // 图例/图头却已经是新票，看起来像「切了但没切」
    setBars([]);
    setInd(null);
    setMinute(null);
    // 换票/换周期后旧的 K 线索引已经没意义
    xhairRef.current = null;
    xhairOn.current = false;
    pendingRange.current = null;

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
    // 只有「同一只票、同一周期、同一份数据」的重绘才还原视野
    const savedRange =
      viewRef.current.key === viewKey && viewRef.current.bars === bars
        ? viewRef.current.range
        : null;
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
      renderKline(chart, bars, ind, { kind: mainKind, ma: maVisible, sup, bands: supBands });
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
      viewRef.current.bars = bars;
    }, 0);
  }, [bars, ind, minute, period, subPanes, selected, maVisible, mainKind, supBands, fortune]);

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
      sup: sup
        ? {
            sell: at(sup.sell),
            risk: at(sup.risk),
            cost: at(sup.cost),
            mid: at(sup.mid),
            floor: at(sup.floor),
            iron: at(sup.iron),
            diff: at(sup.diff),
          }
        : null,
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
      cyht: fortune
        ? {
            sk: at(fortune.sk),
            sd: at(fortune.sd),
            buy: at(fortune.buy),
            sell: at(fortune.sell),
            golden: fortune.golden[idx] === true,
            dead: fortune.dead[idx] === true,
          }
        : null,
      hovered: hoverIdx !== null,
    };
  }, [bars, ind, hoverIdx, sup, fortune]);

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
    main: { kind: MainKind; ma: boolean[]; sup: SupportPressure | null; bands: SupBands },
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
    candleRef.current = candles;

    // 光标定位索引表
    const idxMap = new Map<number, number>();
    list.forEach((b, i) => idxMap.set(toTs(b.date), i));
    timeIdxRef.current = idxMap;

    /** 主图加一条线；values 与 list 等长，NaN 自动跳过 */
    const line = (
      values: number[],
      color: string,
      lineWidth: 1 | 2 | 3 | 4 = 1,
      lineStyle: LineStyle = LineStyle.Solid,
    ) => {
      const s = chart.addSeries(
        LineSeries,
        {
          color,
          lineWidth,
          lineStyle,
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

    if (main.kind === 'SUP' && main.sup) {
      // 大智慧「支撑压力」：六条成本/风险带 + 持仓（灰）与减仓（黄）竖柱
      const s = main.sup;
      // 1.3× / 0.7× 两条极值带只在「全部 6 条」时画：它们参与价格轴自适应，
      // 一起画上会把 K 线压成一条细带
      if (main.bands === 'all') line(s.sell, SUP_COLORS.sell, 2);
      line(s.risk, SUP_COLORS.risk);
      line(s.cost, SUP_COLORS.cost, 2);
      line(s.mid, SUP_COLORS.mid, 1, LineStyle.Dashed);
      line(s.floor, SUP_COLORS.floor);
      if (main.bands === 'all') line(s.iron, SUP_COLORS.iron, 2, LineStyle.Dashed);
      candles.attachPrimitive(
        new StickLinesPrimitive({
          top: s.slow,
          bottom: s.fast,
          diff: s.diff,
          holdColor: SUP_HOLD_COLOR,
          reduceColor: SUP_REDUCE_COLOR,
          widthRatio: SUP_STICK_RATIO,
        }),
      );
    } else if (indicators) {
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
      subPanes.forEach((key, i) => renderSub(chart, indicators, list, 2 + i, key, fortune));
    }
  }

  function renderSub(
    chart: IChartApi,
    s: IndicatorSeries,
    list: Bar[],
    paneIndex: number,
    kind: SubIndicator,
    fortune: Fortune | null,
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
    } else if (kind === 'RSI') {
      mk(s.rsi6, MA_COLORS[0]);
      mk(s.rsi12, MA_COLORS[1]);
    } else if (kind === 'CYHT') {
      // 大智慧「财运亨通」：SK/SD + 80/50/20 三条水平线 + 两段 FILLRGN 填充
      if (!fortune) return;
      const f = fortune;

      /**
       * 副图价格轴钉死在 0~100：随机指标天然落在这个区间，
       * 固定之后 80/50/20 三条线的位置不随窗口缩放漂移，和大智慧观感一致。
       */
      const mkFixed = (
        values: number[],
        color: string,
        lineWidth: 1 | 2 = 1,
        lineStyle: LineStyle = LineStyle.Solid,
      ) => {
        const ser = chart.addSeries(
          LineSeries,
          {
            color,
            lineWidth,
            lineStyle,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
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

      // 逃顶 80（红虚）、楚河分界 50（灰点）、吸货 20（绿虚）
      mkFixed(
        list.map(() => FORTUNE_TOP),
        CYHT_COLORS.top,
        1,
        LineStyle.Dashed,
      );
      mkFixed(
        list.map(() => FORTUNE_MID),
        CYHT_COLORS.mid,
        1,
        LineStyle.Dotted,
      );
      mkFixed(
        list.map(() => FORTUNE_BOTTOM),
        CYHT_COLORS.bottom,
        1,
        LineStyle.Dashed,
      );
      // 买进 22 / 金叉 40，卖出 78 / 死叉 60；原码是普通输出线，故画成阶梯线
      mkFixed(f.buy, CYHT_COLORS.buy);
      mkFixed(f.sell, CYHT_COLORS.sell);

      const sdSer = mkFixed(f.sd, CYHT_COLORS.sd, 2);
      mkFixed(f.sk, CYHT_COLORS.sk, 2);

      // FILLRGN(sd,80,sd>80) 黄、FILLRGN(sd,20,sd<20) 蓝，挂在 SD 线上取同一套坐标
      sdSer.attachPrimitive(
        new BandFillPrimitive({
          values: f.sd,
          base: FORTUNE_TOP,
          above: true,
          color: CYHT_FILL_TOP,
        }),
      );
      sdSer.attachPrimitive(
        new BandFillPrimitive({
          values: f.sd,
          base: FORTUNE_BOTTOM,
          above: false,
          color: CYHT_FILL_BOTTOM,
        }),
      );
    }
  }

  const isMinute = period === 'minute';
  const showMa = !isMinute && !!legend && mainKind === 'MA';
  const showBoll = !isMinute && !!legend && mainKind === 'BOLL';
  const showSup = !isMinute && !!legend && mainKind === 'SUP';

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
        {/* 当日行情摘要直接排在周期行里、紧贴「月K」右边，省下图表顶部一行 */}
        <div className="period-legend" title="当日行情摘要（窗口较窄时可横向滚动查看）">
          {isMinute && minuteLegend && (
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
          )}
          {!isMinute && legend && (
            <div className="legend-row">
              <span className="legend-time">{legend.b.date}</span>
              <span className="lg-ohl">
                <i>开</i>
                <b className={`num ${cls(legend.chg)}`}>{fmtNum(legend.b.open)}</b>
              </span>
              <span className="lg-ohl">
                <i>高</i>
                <b className={`num ${cls(legend.chg)}`}>{fmtNum(legend.b.high)}</b>
              </span>
              <span className="lg-ohl">
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
          )}
        </div>
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
                  <i>主图指标</i>
                  <select
                    className="ind-select"
                    value={mainKind ?? 'NONE'}
                    onChange={(e) => setMainKind(e.target.value === 'NONE' ? null : (e.target.value as MainIndicator))}
                  >
                    <option value="NONE">无</option>
                    {MAIN_INDICATORS.map((k) => (
                      <option key={k} value={k}>
                        {MAIN_LABELS[k]}
                      </option>
                    ))}
                  </select>
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
                {mainKind === 'SUP' && (
                  <div className="ind-pop-row">
                    <i>价格带</i>
                    <div className="ind-chips">
                      <button
                        className={supBands === 'all' ? 'on' : ''}
                        onClick={() => setSupBands('all')}
                        title="按原码画全：含 1.3× 必卖线与 0.7× 铁底线，价格轴会被拉开"
                      >
                        全部 6 条
                      </button>
                      <button
                        className={supBands === 'core' ? 'on' : ''}
                        onClick={() => setSupBands('core')}
                        title="只留风险/成本/中枢/底线，K 线看得清"
                      >
                        核心 4 条
                      </button>
                    </div>
                  </div>
                )}
                <div className="ind-pop-tip">
                  {mainKind === 'MA' ? (
                    <span className="ind-link" onClick={toggleAllMa}>
                      均线{maAllOff ? '全开' : '全关'}
                    </span>
                  ) : mainKind === 'BOLL' ? (
                    '布林带 (20, 2)，中轨即 MA20'
                  ) : mainKind === 'SUP' ? (
                    <span title="大智慧原码：EMA(SLOPE(C,21)×20+C,55) 与 EMA(C,3) 之间画竖柱">
                      6 条成本/风险带，灰柱＝持仓、黄柱＝减仓
                    </span>
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
                  <select
                    className="ind-select"
                    value={subPanes.length}
                    onChange={(e) => setSubCount(Number(e.target.value))}
                    title="最多 4 个副图"
                  >
                    {Array.from({ length: MAX_SUB_PANES + 1 }, (_, n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
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
                          {SUB_LABELS[o]}
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
          {/* 加入自选：弹窗里选已有文件夹或就地新建 */}
          <span className="period-tab add-watch" onClick={() => setWatchOpen(true)} title="把这只票加入自选文件夹">
            ＋自选
            <i className="caret">▾</i>
          </span>
        </span>
      </div>

      <div className="chart-host" ref={hostRef}>
        {loading && <div className="chart-loading">加载中…</div>}
        {!loading && error && <div className="chart-loading">加载失败：{error}</div>}
        {!loading && !error && !bars.length && !minute && <div className="chart-loading">暂无数据</div>}

        {!isMinute && legend && (showMa || showBoll || showSup) && (
          <div className="chart-legend">
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
                {showSup && legend.sup && (
                  <>
                    <span className="legend-tag">支撑压力</span>
                    {SUP_LABELS.filter((o) => supBands === 'all' || SUP_CORE_KEYS.has(o.key)).map(
                      (o) => (
                        <span key={o.key} style={{ color: o.color }}>
                          {o.name} <b className="num">{fmtNum(legend.sup?.[o.key] ?? null)}</b>
                        </span>
                      ),
                    )}
                    <span
                      style={{ color: (legend.sup.diff ?? 0) >= 0 ? SUP_HOLD_COLOR : SUP_REDUCE_COLOR }}
                    >
                      {(legend.sup.diff ?? 0) >= 0 ? '持仓' : '减仓'}
                    </span>
                  </>
                )}
            </div>
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
                <span className="legend-tag">{SUB_LABELS[key]}</span>
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
                {key === 'CYHT' && legend.cyht && (
                  <>
                    <span style={{ color: CYHT_COLORS.sk }}>
                      SK <b className="num">{fmtNum(legend.cyht.sk)}</b>
                    </span>
                    <span style={{ color: CYHT_COLORS.sd }}>
                      SD <b className="num">{fmtNum(legend.cyht.sd)}</b>
                    </span>
                    <span style={{ color: CYHT_COLORS.buy }}>
                      买进 <b className="num">{fmtNum(legend.cyht.buy)}</b>
                    </span>
                    <span style={{ color: CYHT_COLORS.sell }}>
                      卖出 <b className="num">{fmtNum(legend.cyht.sell)}</b>
                    </span>
                    {legend.cyht.golden ? (
                      <span style={{ color: CYHT_COLORS.buy, fontWeight: 600 }}>金叉</span>
                    ) : legend.cyht.dead ? (
                      <span style={{ color: CYHT_COLORS.sell, fontWeight: 600 }}>死叉</span>
                    ) : (legend.cyht.sd ?? 50) > FORTUNE_TOP ? (
                      <span style={{ color: CYHT_COLORS.top }}>逃顶区</span>
                    ) : (legend.cyht.sd ?? 50) < FORTUNE_BOTTOM ? (
                      <span style={{ color: CYHT_COLORS.bottom }}>吸货区</span>
                    ) : null}
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
        <span
          className="foot-btn"
          onClick={toggleSidebar}
          title={sidebar ? '收起左侧面板' : '展开左侧面板'}
        >
          {sidebar ? '◀ 左侧' : '▶ 左侧'}
        </span>
        <span className="foot-hint">
          ← → 移动光标　↑ ↓ 缩放　【 】{posLabel ? `${posLabel}内换股` : '换股'}
        </span>
        {posLabel && (
          <span
            className="foot-hint"
            title={posFolder ? `当前在自选文件夹「${posLabel}」内` : `从${posLabel}列表点进来的`}
          >
            当前位置：【{posLabel}】
          </span>
        )}
        {/* 当前位置右边：切到某个自选文件夹（文件夹和五大板块是同一类「位置」） */}
        <span className="pos-wrap">
          <button
            className={`foot-btn pos-btn${posOpen ? ' on' : ''}`}
            onClick={() => {
              setPosOpen((v) => !v);
              setBoardOpen(false);
            }}
            title="选择自选板块（文件夹），左侧按板块方式显示"
          >
            自选板块<i className="caret">▾</i>
          </button>
          {posOpen && <PosMenu onClose={() => setPosOpen(false)} />}
        </span>
        {/* 再往右：切到五大板块之一，显示方式与自选完全一致 */}
        <span className="pos-wrap">
          <button
            className={`foot-btn pos-btn${boardOpen ? ' on' : ''}`}
            onClick={() => {
              setBoardOpen((v) => !v);
              setPosOpen(false);
            }}
            title="选择沪深京板块，左侧按同一套方式显示其全部股票"
          >
            沪深京<i className="caret">▾</i>
          </button>
          {boardOpen && <BoardMenu onClose={() => setBoardOpen(false)} />}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          {legend ? (legend.hovered ? `光标 ${legend.b.date}` : `最新 ${lastDate}`) : lastDate}
        </span>
      </div>

      {activeBoard && (
        <BoardModal board={activeBoard} onClose={() => setActiveBoard(null)} />
      )}

      {watchOpen && selected && (
        <WatchAddModal symbol={selected} fallbackName={name} onClose={() => setWatchOpen(false)} />
      )}
    </div>
  );
}
