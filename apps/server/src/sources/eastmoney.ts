import type { Bar } from '../types.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TIMEOUT = 15000;

interface EmResp {
  rc?: number;
  data?: {
    code?: string;
    name?: string;
    dktotal?: number;
    klines?: string[];
  } | null;
}

/** 沪深京 → 东财 secid：沪市 1.，深市/北交所 0. */
function toSecid(symbol: string): string | null {
  const m = /^(sh|sz|bj)(\d{6})$/.exec(symbol.toLowerCase());
  if (!m) return null;
  return `${m[1] === 'sh' ? '1' : '0'}.${m[2]}`;
}

/**
 * 东方财富历史 K 线（push2his），前复权。
 *
 * 与腾讯 fqkline 的差别：腾讯单次最多 640 根，东财返回自上市以来全部
 * （600685 为 7652 根、000001 为 8497 根）。两市同一交易日的
 * 开高低收量逐字段一致，可互相替代。
 *
 * 注意：前复权在长期高送转个股上会出现负价（如 000001 的 1991 年），
 * 这是复权计算的结果，不是脏数据，保留原样。
 */
export async function fetchKlineFull(
  symbol: string,
  period: 'day' | 'week' | 'month',
  limit = 10000,
): Promise<Bar[]> {  const secid = toSecid(symbol);
  if (!secid) return [];
  const klt = period === 'day' ? 101 : period === 'week' ? 102 : 103;
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56` +
    `&klt=${klt}&fqt=1&beg=0&end=20500101&lmt=${Math.min(20000, Math.max(1, limit))}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} eastmoney`);
  const json = (await res.json()) as EmResp;
  const raw = json?.data?.klines;
  if (!Array.isArray(raw) || !raw.length) return [];

  const bars: Bar[] = [];
  for (const line of raw) {
    // 列序：日期, 开, 收, 高, 低, 量
    const p = line.split(',');
    if (p.length < 6) continue;
    const date = p[0];
    const open = Number(p[1]);
    const close = Number(p[2]);
    const high = Number(p[3]);
    const low = Number(p[4]);
    const volume = Number(p[5]);
    if (!date || !Number.isFinite(close) || close === 0) continue;
    bars.push({
      date,
      open: Number.isFinite(open) ? open : close,
      close,
      high: Number.isFinite(high) ? high : close,
      low: Number.isFinite(low) ? low : close,
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
    });
  }
  return bars;
}

/** 东财 F10 返回的板块标签（所属板块 ssbk） */
export interface EmBoardTag {
  /** 板块名，如「电子」「半导体」「专精特新」 */
  name: string;
  /** 东财板块代码，4 位数字，如 1201 */
  code: string;
  /** 东财给的排序，越小越靠前（一级行业在前） */
  rank: number;
}

/**
 * 个股所属板块（东财 F10「核心题材」页的 ssbk）。
 *
 * 腾讯只提供「板块 → 成分股」，且成分股里不含科创板（688）与北交所（920），
 * 这两个市场的板块归属只能反过来按个股问东财。返回的板块名可与腾讯板块名
 * 对齐后复用同一套 K 线 / 成分股能力。
 *
 * code 参数格式为 SH/SZ/BJ + 6 位代码，北交所同样认 BJ920xxx。
 */
export async function fetchStockBoardTags(symbol: string): Promise<EmBoardTag[]> {
  const m = /^(sh|sz|bj)(\d{6})$/i.exec(symbol.toLowerCase());
  if (!m) return [];
  const prefix = m[1] === 'sh' ? 'SH' : m[1] === 'sz' ? 'SZ' : 'BJ';
  const url =
    'https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax' +
    `?code=${prefix}${m[2]}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://emweb.securities.eastmoney.com/' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} eastmoney f10`);
  const json = (await res.json()) as {
    ssbk?: Array<{ BOARD_NAME?: string; BOARD_CODE?: string; BOARD_RANK?: number }>;
  };
  const list = Array.isArray(json?.ssbk) ? json.ssbk : [];
  const out: EmBoardTag[] = [];
  const seen = new Set<string>();
  list.forEach((b, i) => {
    const name = String(b?.BOARD_NAME ?? '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({
      name,
      code: String(b?.BOARD_CODE ?? ''),
      rank: Number.isFinite(Number(b?.BOARD_RANK)) ? Number(b.BOARD_RANK) : i,
    });
  });
  return out;
}
