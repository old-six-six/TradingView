import { fetchBoardStocks, type BoardKind } from '../sources/tencentBoard.js';
import { fetchKline } from '../sources/tencent.js';
import { esc, exec, query, upsertBatch } from '../db/sqlite.js';
import type { Bar } from '../types.js';

/**
 * 板块指数合成。
 *
 * 腾讯的板块接口只给「当日 K 线 + 当日分时」，没有历史日 K；
 * 东财的板块历史 K 线（push2his）只认自己的 BK 代码，与腾讯的 pt 代码不通用，
 * 按名称去东财搜也只能命中约一半（且存在张冠李戴风险）。
 *
 * 所以这里用板块成分股自己合成指数：
 *   - 取成分股里总市值最大的前 100 只（覆盖绝大部分权重）
 *   - 每只按自身前收算当日涨跌幅，按市值加权平均，累乘成指数（基点 1000）
 *   - 开/高/低同样用个股相对前收的偏离度加权反推，保证有合理的影线
 *
 * 结果落 board_bar 表缓存，24 小时内直接读库。
 */

const TOP_N = 100;
/** 合成一次板块指数要拉上百只票的 K 线，并发压低一点，别把上游 WAF 惹毛 */
const CONCURRENCY = 4;
const TTL_MS = 24 * 3600 * 1000;
const BASE = 1000;

interface Acc {
  w: number;
  ret: number;
  retO: number;
  retH: number;
  retL: number;
  vol: number;
}

async function mapLimit<T, R>(
  list: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function synth(series: Array<{ w: number; bars: Bar[] }>): Bar[] {
  const acc = new Map<string, Acc>();
  for (const s of series) {
    for (let i = 1; i < s.bars.length; i++) {
      const b = s.bars[i];
      const p = s.bars[i - 1];
      if (!(p.close > 0) || !(b.close > 0)) continue;
      let a = acc.get(b.date);
      if (!a) {
        a = { w: 0, ret: 0, retO: 0, retH: 0, retL: 0, vol: 0 };
        acc.set(b.date, a);
      }
      a.w += s.w;
      a.ret += s.w * (b.close / p.close - 1);
      a.retO += s.w * (b.open / p.close - 1);
      a.retH += s.w * (b.high / p.close - 1);
      a.retL += s.w * (b.low / p.close - 1);
      a.vol += b.volume;
    }
  }
  const dates = [...acc.keys()].sort();
  const out: Bar[] = [];
  let idx = BASE;
  for (const date of dates) {
    const a = acc.get(date)!;
    if (!(a.w > 0)) continue;
    const prev = idx;
    const r = a.ret / a.w;
    idx = prev * (1 + r);
    const o = a.retO / a.w;
    const h = Math.max(a.retH / a.w, r);
    const l = Math.min(a.retL / a.w, r);
    out.push({
      date,
      open: prev * (1 + o),
      high: prev * (1 + h),
      low: prev * (1 + l),
      close: idx,
      volume: a.vol,
    });
  }
  return out;
}

/** 板块日 K。缓存 24 小时；没有缓存则现算（约 3–6 秒） */
export async function boardBars(
  code: string,
  kind: BoardKind,
  days = 400,
): Promise<{ bars: Bar[]; cached: boolean }> {
  const meta = await query<{ bars_at: string | null; bars_count: number | null }>(
    `SELECT bars_at, bars_count FROM board WHERE code = ${esc(code)} LIMIT 1`,
  );
  const at = meta[0]?.bars_at ? Date.parse(meta[0].bars_at) : 0;
  const fresh = at && Date.now() - at < TTL_MS;

  if (fresh) {
    const rows = await query<Bar>(
      `SELECT date, open, high, low, close, volume FROM board_bar
        WHERE board_code = ${esc(code)} ORDER BY date DESC LIMIT ${Math.max(20, days)}`,
    );
    if (rows.length) return { bars: rows.reverse(), cached: true };
  }

  const stocks = await fetchBoardStocks(code, kind, 800);
  if (!stocks.length) return { bars: [], cached: false };
  const pick = [...stocks]
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, TOP_N)
    .filter((s) => s.marketCap > 0);

  const klines = await mapLimit(pick, CONCURRENCY, async (s) => {
    try {
      return { w: s.marketCap, bars: await fetchKline(s.symbol, 'day', 640) };
    } catch {
      return { w: s.marketCap, bars: [] as Bar[] };
    }
  });

  const bars = synth(klines.filter((k) => k.bars.length > 1));
  if (!bars.length) return { bars: [], cached: false };

  await upsertBatch(
    'board_bar',
    ['board_code', 'date', 'open', 'high', 'low', 'close', 'volume'],
    bars.map((b) => [
      esc(code),
      esc(b.date),
      String(b.open),
      String(b.high),
      String(b.low),
      String(b.close),
      String(b.volume),
    ]),
  );
  await exec(
    `UPDATE board SET bars_at = ${esc(new Date().toISOString())}, bars_count = ${pick.length}
      WHERE code = ${esc(code)}`,
  );

  return { bars: bars.slice(-days), cached: false };
}
