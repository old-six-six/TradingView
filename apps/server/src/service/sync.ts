import { fetchKline } from '../sources/tencent.js';
import { fetchKlineFull } from '../sources/eastmoney.js';
import { upsertDailyBars, upsertIndicators, getDailyBars } from '../db/repo.js';
import { calcIndicators } from '../engine/indicator.js';
import { DAILY_BARS, FULL_HISTORY } from '../config.js';
import type { Bar } from '../types.js';

export interface SyncResult {
  symbol: string;
  ok: boolean;
  bars: number;
  source?: string;
  error?: string;
}

/**
 * 单只票的日 K 全量刷新 + 指标重算。
 *
 * 优先东财取「上市以来全部」历史（腾讯单次硬上限 640 根），东财失败
 * 时退回腾讯最近 640 根，保证界面不至于空白。
 */
export async function syncOne(symbol: string, count = DAILY_BARS): Promise<SyncResult> {
  let bars: Bar[] = [];
  let source = 'eastmoney';
  try {
    bars = await fetchKlineFull(symbol, 'day', FULL_HISTORY);
  } catch {
    bars = [];
  }
  if (!bars.length) {
    source = 'tencent';
    try {
      bars = await fetchKline(symbol, 'day', count);
    } catch (e) {
      return { symbol, ok: false, bars: 0, source, error: (e as Error).message };
    }
  }
  if (!bars.length) return { symbol, ok: false, bars: 0, source, error: '接口返回空' };

  try {
    await upsertDailyBars(symbol, bars);
    // 指标按库里全部历史重算，均线/MACD 的起始段才正确
    const stored = await getDailyBars(symbol, 0);
    const ind = calcIndicators(stored);
    await upsertIndicators(symbol, ind);
    return { symbol, ok: true, bars: bars.length, source };
  } catch (e) {
    return { symbol, ok: false, bars: 0, source, error: (e as Error).message };
  }
}

/** 串行分批同步，避免触发限流 */
export async function syncMany(
  symbols: string[],
  onProgress?: (done: number, total: number, r: SyncResult) => void,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (let i = 0; i < symbols.length; i++) {
    const r = await syncOne(symbols[i]);
    results.push(r);
    onProgress?.(i + 1, symbols.length, r);
    await new Promise((res) => setTimeout(res, 180));
  }
  return results;
}
