import type { Quote, Bar, MinutePoint, Level } from '../types.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TIMEOUT = 8000;

/** 把裸代码补全成带市场前缀的 symbol */
export function toSymbol(input: string): string {
  const s = input.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s;
  const code = s.replace(/\D/g, '');
  if (code.length !== 6) return s;
  if (/^(6)/.test(code)) return `sh${code}`;
  if (/^(0|3)/.test(code)) return `sz${code}`;
  if (/^(4|8|9)/.test(code)) return `bj${code}`;
  return `sh${code}`;
}

async function getText(url: string, gbk = false): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return gbk ? new TextDecoder('gbk').decode(buf) : buf.toString('utf8');
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as T;
}

function toLevels(arr: string[], start: number): Level[] {
  const out: Level[] = [];
  for (let i = 0; i < 5; i++) {
    const price = Number(arr[start + i * 2]);
    const volume = Number(arr[start + i * 2 + 1]);
    if (Number.isFinite(price) && price > 0) {
      out.push({ price, volume: Number.isFinite(volume) ? volume : 0 });
    }
  }
  return out;
}

function fmtTime(raw: string): string {
  if (!/^\d{14}$/.test(raw)) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(
    10,
    12,
  )}:${raw.slice(12, 14)}`;
}

/**
 * 腾讯实时快照。字段以 ~ 分隔，索引含义见 docs。
 * 单次建议不超过 400 只（更长的 URL 会被 414 拒绝）。
 */
export async function fetchQuotes(symbols: string[]): Promise<Quote[]> {
  const snaps = await fetchSnapshots(symbols);
  return snaps.map((s) => ({
    symbol: s.symbol,
    name: s.name,
    code: s.code,
    price: s.price,
    prevClose: s.prevClose,
    open: s.open,
    high: s.high,
    low: s.low,
    change: s.change,
    changePct: s.changePct,
    volume: s.volume,
    amount: s.amount,
    turnoverRate: s.turnoverRate,
    pe: s.pe,
    pb: s.pb,
    amplitude: s.amplitude,
    marketCap: s.marketCap,
    floatCap: s.floatCap,
    volumeRatio: s.volumeRatio,
    avgPrice: s.avgPrice,
    limitUp: s.limitUp,
    limitDown: s.limitDown,
    bids: s.bids,
    asks: s.asks,
    time: s.time,
  }));
}

/** 快照的全部字段，列表页要用的外盘/内盘/委差等只在这里出现 */
export interface Snapshot extends Quote {
  /** 外盘（手） */
  outerVolume: number;
  /** 内盘（手） */
  innerVolume: number;
  /** 五档买量合计（手） */
  bidVolume: number;
  /** 五档卖量合计（手） */
  askVolume: number;
  /** 委差（手），腾讯直接给 */
  weicha: number;
  /** 动态市盈率 */
  peDyn: number | null;
  /** 静态市盈率 */
  peStatic: number | null;
}

/** 批量抓原始快照；内部按 400 只切块并发 */
export async function fetchSnapshots(symbols: string[], chunk = 400): Promise<Snapshot[]> {
  if (!symbols.length) return [];
  const groups: string[][] = [];
  for (let i = 0; i < symbols.length; i += chunk) groups.push(symbols.slice(i, i + chunk));
  const pages = await Promise.all(
    groups.map(async (g) => {
      try {
        return await fetchSnapshotChunk(g);
      } catch {
        return [] as Snapshot[];
      }
    }),
  );
  return pages.flat();
}

async function fetchSnapshotChunk(symbols: string[]): Promise<Snapshot[]> {
  const url = `https://qt.gtimg.cn/q=${symbols.join(',')}`;
  const text = await getText(url, true);
  const out: Snapshot[] = [];
  const re = /v_(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const symbol = m[1];
    const f = m[2].split('~');
    if (f.length < 50 || !f[3]) continue;
    const price = Number(f[3]);
    if (!Number.isFinite(price) || price === 0) continue;
    const bids = toLevels(f, 9);
    const asks = toLevels(f, 19);
    out.push({
      symbol,
      name: f[1] ?? '',
      code: f[2] ?? symbol.slice(2),
      price,
      prevClose: Number(f[4]) || 0,
      open: Number(f[5]) || 0,
      high: Number(f[33]) || 0,
      low: Number(f[34]) || 0,
      change: Number(f[31]) || 0,
      changePct: Number(f[32]) || 0,
      volume: Number(f[6]) || 0,
      amount: (Number(f[37]) || 0) * 10000,
      turnoverRate: Number(f[38]) || 0,
      pe: Number(f[39]) || null,
      pb: Number(f[46]) || null,
      amplitude: Number(f[43]) || 0,
      marketCap: (Number(f[45]) || 0) * 1e8,
      floatCap: (Number(f[44]) || 0) * 1e8,
      volumeRatio: Number(f[49]) || 0,
      avgPrice: Number(f[51]) || price,
      limitUp: Number(f[47]) || 0,
      limitDown: Number(f[48]) || 0,
      outerVolume: Number(f[7]) || 0,
      innerVolume: Number(f[8]) || 0,
      bidVolume: bids.reduce((s, l) => s + l.volume, 0),
      askVolume: asks.reduce((s, l) => s + l.volume, 0),
      weicha: Number(f[50]) || 0,
      peDyn: Number(f[52]) || null,
      peStatic: Number(f[53]) || null,
      bids,
      asks,
      time: fmtTime(f[30] ?? ''),
    });
  }
  return out;
}

interface KlineResp {
  code: number;
  msg?: string;
  data?: Record<string, Record<string, unknown>>;
}

/**
 * 腾讯前复权 K 线的两个入口。
 *
 * 老域名 `web.ifzq.gtimg.cn/appstock/app/fqkline/get` 会被腾讯 WAF 判 501
 * （返回 waf.tencent.com/501page.html，HTTP 501 + 一段跳转脚本），一旦命中
 * 该域名下所有股票的 fqkline 全部拿不到数据。`proxy.finance.qq.com` 下的
 * newfqkline 是同一接口的新入口，返回结构一致（qfqday / qfqweek / qfqmonth），
 * 目前稳定。两个都留着互为备份。
 */
const QFQ_HOSTS = [
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get',
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
];

/** 不复权端点，仅在前复权两个入口都失败时兜底（价格与实时价一致，历史不复权） */
const RAW_HOST = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline';

/** 腾讯单次请求能取到的最大根数，再多会返回 param error */
export const KLINE_PAGE = 640;

function pickRows(
  node: Record<string, unknown> | undefined,
  period: string,
): Array<Array<string | number>> | null {
  if (!node) return null;
  // 前复权端点给 qfqday/qfqweek/qfqmonth，不复权端点只有 day/week/month
  for (const key of [`qfq${period}`, period]) {
    const v = node[key];
    if (Array.isArray(v) && v.length) return v as Array<Array<string | number>>;
  }
  return null;
}

/**
 * 转成 Bar。这里只丢掉字段缺失的坏行，**不按价格正负过滤**：
 * 前复权在长期高送转个股的老历史段会出现负价（如 000001 的 90 年代），
 * 那是复权计算的结果。若在翻页时把它们滤掉，页内根数会不足 640，
 * 会被误判成「已到上市首日」而提前结束翻页。
 */
function toBars(raw: Array<Array<string | number>>): Bar[] {
  return raw
    .map((r) => ({
      // 腾讯列序：日期, 开, 收, 高, 低, 量
      date: String(r[0]),
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      volume: Number(r[5]),
    }))
    .filter(
      (b) =>
        /^\d{4}-\d{2}-\d{2}$/.test(b.date) &&
        Number.isFinite(b.close) &&
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low),
    )
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 负价只出现在老历史段，画到图上会把整根 K 线压到 0 轴以下，渲染前剔掉 */
function positiveOnly(bars: Bar[]): Bar[] {
  return bars.filter((b) => b.close > 0);
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/**
 * 拉一页 K 线（最多 KLINE_PAGE 根）。传 end 表示「截止到这一天（含）」，
 * 用来把窗口往前挪着翻页。
 */
async function fetchKlinePage(
  symbol: string,
  period: 'day' | 'week' | 'month',
  count: number,
  end?: string,
): Promise<Bar[]> {
  const n = Math.min(KLINE_PAGE, Math.max(1, Math.floor(count)));
  const param = `${symbol},${period},,${end ?? ''},${n},qfq`;
  let lastErr: unknown = null;

  for (const host of QFQ_HOSTS) {
    try {
      const json = await getJson<KlineResp>(`${host}?param=${param}`);
      const rows = pickRows(json?.data?.[symbol], period);
      if (rows) return toBars(rows);
    } catch (e) {
      lastErr = e;
    }
  }

  // 前复权都挂了：退到不复权端点，形态还能看，价格轴与实时价一致
  try {
    const json = await getJson<KlineResp>(`${RAW_HOST}?param=${symbol},${period},,,${n}`);
    const rows = pickRows(json?.data?.[symbol], period);
    if (rows) return toBars(rows);
  } catch (e) {
    lastErr = e;
  }

  if (lastErr) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  return [];
}

/** 日/周/月 K，前复权。单页最多 640 根，返回按时间升序 */
export async function fetchKline(
  symbol: string,
  period: 'day' | 'week' | 'month',
  count = KLINE_PAGE,
): Promise<Bar[]> {
  return positiveOnly(await fetchKlinePage(symbol, period, count));
}

/** 翻页上限：640 根 × 40 页 = 25600 根，足够覆盖最老的票 */
const MAX_PAGES = 40;

/**
 * 抓尽可能长的历史。腾讯单次上限 640 根，返回不满一页说明已到上市首日；
 * 否则用 end 参数把窗口一段段往前挪，直到凑够 want（want <= 0 表示翻到底）。
 * 这是东财 push2his 被封之后取全量历史的唯一可靠路子。
 */
export async function fetchKlineDeep(
  symbol: string,
  period: 'day' | 'week' | 'month',
  want = 0,
): Promise<Bar[]> {
  const seen = new Map<string, Bar>();
  let end: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchKlinePage(symbol, period, KLINE_PAGE, end);
    if (!page.length) break;
    for (const b of page) seen.set(b.date, b);
    if (want > 0 && seen.size >= want) break;
    if (page.length < KLINE_PAGE) break; // 到头了
    const next = shiftDate(page[0].date, -1);
    if (end === next) break; // 上游无视 end 参数时防死循环
    end = next;
  }
  const all = positiveOnly([...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1)));
  return want > 0 && all.length > want ? all.slice(all.length - want) : all;
}

interface MinuteResp {
  code: number;
  data?: Record<
    string,
    {
      date?: string;
      data?: { date?: string; data?: string[] };
      qt?: Record<string, string[]>;
    }
  >;
}

/** 当日 1 分钟分时。累计量/额已转换为当分钟增量 */
export async function fetchMinute(symbol: string): Promise<{ date: string; points: MinutePoint[] }> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`;
  const json = await getJson<MinuteResp>(url);
  const node = json?.data?.[symbol];
  const rows = node?.data?.data;
  const rawDate = node?.data?.date ?? node?.date ?? '';
  const date = /^\d{8}$/.test(rawDate)
    ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
    : rawDate;

  if (!Array.isArray(rows)) return { date, points: [] };

  let prevVol = 0;
  let prevAmt = 0;
  const points: MinutePoint[] = [];
  for (const line of rows) {
    const [t, p, cumVol, cumAmt] = line.split(' ');
    const price = Number(p);
    if (!Number.isFinite(price) || price <= 0) continue;
    const v = Number(cumVol) || 0;
    const a = Number(cumAmt) || 0;
    points.push({
      time: `${t.slice(0, 2)}:${t.slice(2, 4)}`,
      price,
      volume: Math.max(0, v - prevVol),
      amount: Math.max(0, a - prevAmt),
    });
    prevVol = v;
    prevAmt = a;
  }
  return { date, points };
}
