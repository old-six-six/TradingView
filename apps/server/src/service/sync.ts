import { refreshDailyBars } from './kline.js';
import { DAILY_BARS } from '../config.js';

export interface SyncResult {
  symbol: string;
  ok: boolean;
  bars: number;
  source?: string;
  error?: string;
}

/**
 * 单只票的日 K 刷新 + 指标重算。
 * 具体取数策略（缓存优先、补最新一页、前复权漂移重抓）在 service/kline.ts，
 * 这里只负责把异常收成结果对象，供启动流程和批量同步使用。
 */
export async function syncOne(symbol: string, count = DAILY_BARS): Promise<SyncResult> {
  try {
    const r = await refreshDailyBars(symbol, { count });
    return { symbol, ok: r.bars > 0, bars: r.bars, source: r.source };
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
