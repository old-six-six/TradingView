import { fetchKline } from '../sources/tencent.js';
import { upsertDailyBars, upsertIndicators, getDailyBars } from '../db/repo.js';
import { calcIndicators } from '../engine/indicator.js';
import { DAILY_BARS } from '../config.js';

export interface SyncResult {
  symbol: string;
  ok: boolean;
  bars: number;
  error?: string;
}

/** 单只票的日 K 全量刷新 + 指标重算 */
export async function syncOne(symbol: string, count = DAILY_BARS): Promise<SyncResult> {
  try {
    const bars = await fetchKline(symbol, 'day', count);
    if (!bars.length) return { symbol, ok: false, bars: 0, error: '接口返回空' };
    await upsertDailyBars(symbol, bars);
    const stored = await getDailyBars(symbol, 1200);
    const ind = calcIndicators(stored);
    await upsertIndicators(symbol, ind);
    return { symbol, ok: true, bars: bars.length };
  } catch (e) {
    return { symbol, ok: false, bars: 0, error: (e as Error).message };
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
