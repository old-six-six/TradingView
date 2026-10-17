import type { Bar } from '../types.js';

/**
 * 腾讯板块（行业 / 概念 / 地域）数据源。
 *
 * 东财的板块接口（push2 clist）在本机被 WAF 静默拦截，返回空 body，
 * 而腾讯这套 proxy.finance.qq.com 的板块接口全部可用：
 *   - 板块列表  /rank/pt/getRank
 *   - 板块成分  /rank/hs/getBoardRankList
 *   - 板块 K 线 web.ifzq.gtimg.cn/appstock/app/fqkline/get（param 传 pt 代码）
 *   - 板块实时  qt.gtimg.cn/q=pt...（与个股同格式）
 *
 * 板块代码形如 pt01801120（行业）、pt02GN2225（概念），与东财 BKxxxx 不通用。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TIMEOUT = 12000;
const BASE = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank';

export type BoardKind = 'gn' | 'hy' | 'dy';

export const BOARD_KIND_LABEL: Record<BoardKind, string> = {
  hy: '行业',
  gn: '概念',
  dy: '地域',
};

export interface BoardInfo {
  code: string;
  name: string;
  kind: BoardKind;
  changePct: number;
  /** 板块内上涨 / 下跌家数 */
  up: number;
  down: number;
}

export interface BoardStock {
  symbol: string;
  code: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  /** 成交额，单位元 */
  amount: number;
  turnoverRate: number;
  volumeRatio: number;
  amplitude: number;
  marketCap: number;
  floatCap: number;
  pe: number | null;
  pb: number | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as T;
}

interface RankResp {
  code?: number;
  data?: {
    rank_list?: Array<Record<string, unknown>>;
    offset?: number;
    total?: number;
  };
}

/** 单次最多 200 条，这个是接口硬限制（300 直接返回空） */
const PAGE = 200;

/**
 * 全量板块列表。概念板块约 800 个，含「昨日涨停」「昨日连板」这类
 * 策略标签（stock_type=BK-GN-FG），它们不是题材概念，建索引时剔除。
 */
export async function fetchBoardList(): Promise<BoardInfo[]> {
  const out: BoardInfo[] = [];
  for (const kind of ['hy', 'gn', 'dy'] as BoardKind[]) {
    for (let off = 0; off < 2000; off += PAGE) {
      const j = await getJson<RankResp>(
        `${BASE}/pt/getRank?board_type=${kind}&sort_type=price&direct=down&offset=${off}&count=${PAGE}`,
      );
      const list = j?.data?.rank_list ?? [];
      if (!list.length) break;
      for (const b of list) {
        if (kind === 'gn' && String(b.stock_type ?? '') === 'BK-GN-FG') continue;
        const code = String(b.code ?? '');
        const name = String(b.name ?? '');
        if (!code || !name) continue;
        const [up, down] = String(b.zgb ?? '')
          .split('/')
          .map((x) => Number(x) || 0);
        out.push({
          code,
          name,
          kind,
          changePct: Number(b.zdf) || 0,
          up: up || 0,
          down: down || 0,
        });
      }
      if (list.length < PAGE) break;
    }
  }
  return out;
}

function mapStock(s: Record<string, unknown>): BoardStock | null {
  const symbol = String(s.code ?? '');
  const price = Number(s.zxj);
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol) || !Number.isFinite(price) || price <= 0) return null;
  const pe = Number(s.pe_ttm);
  const pb = Number(s.pn);
  return {
    symbol,
    code: symbol.slice(2),
    name: String(s.name ?? ''),
    price,
    change: Number(s.zd) || 0,
    changePct: Number(s.zdf) || 0,
    volume: Number(s.volume) || 0,
    // turnover 单位是万元
    amount: (Number(s.turnover) || 0) * 1e4,
    turnoverRate: Number(s.hsl) || 0,
    volumeRatio: Number(s.lb) || 0,
    amplitude: Number(s.zf) || 0,
    // zsz / ltsz 单位是亿元
    marketCap: (Number(s.zsz) || 0) * 1e8,
    floatCap: (Number(s.ltsz) || 0) * 1e8,
    pe: Number.isFinite(pe) ? pe : null,
    pb: Number.isFinite(pb) ? pb : null,
  };
}

/** 板块成分股，已按涨幅降序。max 限制取多少只，默认 800 */
export async function fetchBoardStocks(
  code: string,
  kind: BoardKind,
  max = 800,
): Promise<BoardStock[]> {
  const out: BoardStock[] = [];
  for (let off = 0; off < max; off += PAGE) {
    const j = await getJson<RankResp>(
      `${BASE}/hs/getBoardRankList?board_code=${encodeURIComponent(code)}&board_type=${kind}` +
        `&sort_type=PriceRatio&direct=down&offset=${off}&count=${PAGE}`,
    );
    const list = j?.data?.rank_list ?? [];
    if (!list.length) break;
    for (const s of list) {
      const v = mapStock(s);
      if (v) out.push(v);
    }
    if (list.length < PAGE) break;
  }
  return out;
}

/** 只取成分股代码，供建索引时用（省内存） */
export async function fetchBoardMembers(code: string, kind: BoardKind): Promise<string[]> {
  const out: string[] = [];
  for (let off = 0; off < 4000; off += PAGE) {
    const j = await getJson<RankResp>(
      `${BASE}/hs/getBoardRankList?board_code=${encodeURIComponent(code)}&board_type=${kind}` +
        `&sort_type=PriceRatio&direct=down&offset=${off}&count=${PAGE}`,
    );
    const list = j?.data?.rank_list ?? [];
    if (!list.length) break;
    for (const s of list) {
      const sym = String(s.code ?? '');
      if (/^(sh|sz|bj)\d{6}$/.test(sym)) out.push(sym);
    }
    if (list.length < PAGE) break;
  }
  return [...new Set(out)];
}

interface KlineResp {
  code?: number;
  data?: Record<string, Record<string, Array<Array<string | number>> | undefined> | undefined>;
}

/** 板块日/周/月 K 线。板块指数无复权概念，qfq 参数只为走同一路径 */
export async function fetchBoardBars(
  code: string,
  period: 'day' | 'week' | 'month',
  count = 640,
): Promise<Bar[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,${Math.min(
    640,
    Math.max(20, count),
  )},qfq`;
  const json = await getJson<KlineResp>(url);
  const node = json?.data?.[code] as Record<string, Array<Array<string | number>> | undefined> | undefined;
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

export interface BoardQuote {
  code: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
}

/**
 * 板块实时行情。qt 返回的字段布局与个股一致：
 * 3=现价 4=昨收 31=涨跌 32=涨跌幅。单次不要超过 50 个代码。
 */
export async function fetchBoardQuotes(codes: string[]): Promise<BoardQuote[]> {
  const out: BoardQuote[] = [];
  const CHUNK = 50;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const part = codes.slice(i, i + CHUNK);
    if (!part.length) continue;
    const res = await fetch(`https://qt.gtimg.cn/q=${part.join(',')}`, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) continue;
    const text = new TextDecoder('gbk').decode(Buffer.from(await res.arrayBuffer()));
    for (const m of text.matchAll(/v_(\w+)="([^"]*)"/g)) {
      const f = m[2].split('~');
      const price = Number(f[3]);
      if (f.length < 35 || !Number.isFinite(price) || price <= 0) continue;
      out.push({
        code: m[1],
        name: f[1] ?? '',
        price,
        change: Number(f[31]) || 0,
        changePct: Number(f[32]) || 0,
      });
    }
  }
  return out;
}
