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
 * 单次建议不超过 60 只。
 */
export async function fetchQuotes(symbols: string[]): Promise<Quote[]> {
  if (!symbols.length) return [];
  const url = `https://qt.gtimg.cn/q=${symbols.join(',')}`;
  const text = await getText(url, true);
  const out: Quote[] = [];
  const re = /v_(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const symbol = m[1];
    const f = m[2].split('~');
    if (f.length < 50 || !f[3]) continue;
    const price = Number(f[3]);
    if (!Number.isFinite(price) || price === 0) continue;
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
      bids: toLevels(f, 9),
      asks: toLevels(f, 19),
      time: fmtTime(f[30] ?? ''),
    });
  }
  return out;
}

interface KlineResp {
  code: number;
  data?: Record<string, Record<string, Array<Array<string | number>> | undefined>>;
}

/** 日/周/月 K，前复权。返回按时间升序 */
export async function fetchKline(
  symbol: string,
  period: 'day' | 'week' | 'month',
  count = 640,
): Promise<Bar[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${period},,,${count},qfq`;
  const json = await getJson<KlineResp>(url);
  const node = json?.data?.[symbol];
  if (!node) return [];
  const raw = (node[`qfq${period}`] ?? node[period]) as Array<Array<string | number>> | undefined;
  if (!Array.isArray(raw)) return [];
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
    .filter((b) => b.date && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
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
