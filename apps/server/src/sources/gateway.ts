import { fetchQuotes } from '../sources/tencent.js';
import { lastMarketCache } from '../sources/sina.js';
import type { Quote } from '../types.js';

interface SourceHealth {
  name: string;
  ok: boolean;
  failures: number;
  lastError: string | null;
  lastOkAt: number;
  latencyMs: number;
}

const health: Record<string, SourceHealth> = {
  tencent: { name: '腾讯行情', ok: true, failures: 0, lastError: null, lastOkAt: 0, latencyMs: 0 },
};

const FAIL_THRESHOLD = 5;
const COOL_DOWN = 60_000;
let circuitOpenUntil = 0;

/**
 * 统一行情入口：腾讯为主，失败时用新浪全市场缓存兜底。
 * 连续失败 5 次熔断 60 秒，期间直接走缓存。
 */
export async function getQuotes(symbols: string[]): Promise<{ quotes: Quote[]; stale: boolean }> {
  const uniq = [...new Set(symbols)];
  if (!uniq.length) return { quotes: [], stale: false };

  const now = Date.now();
  if (now < circuitOpenUntil) {
    return { quotes: fallback(uniq), stale: true };
  }

  const t0 = now;
  try {
    const quotes = await fetchQuotes(uniq);
    const h = health.tencent;
    h.ok = true;
    h.failures = 0;
    h.lastError = null;
    h.lastOkAt = Date.now();
    h.latencyMs = Date.now() - t0;
    // 腾讯未返回的票（停牌等）用缓存补齐
    const got = new Set(quotes.map((q) => q.symbol));
    const missing = uniq.filter((s) => !got.has(s));
    if (missing.length) quotes.push(...fallback(missing));
    return { quotes, stale: false };
  } catch (e) {
    const h = health.tencent;
    h.failures += 1;
    h.lastError = (e as Error).message;
    if (h.failures >= FAIL_THRESHOLD) {
      h.ok = false;
      circuitOpenUntil = Date.now() + COOL_DOWN;
    }
    return { quotes: fallback(uniq), stale: true };
  }
}

function fallback(symbols: string[]): Quote[] {
  const { quotes } = lastMarketCache();
  if (!quotes.length) return [];
  const set = new Set(symbols);
  return quotes.filter((q) => set.has(q.symbol));
}

export function sourceHealth(): SourceHealth[] {
  return Object.values(health);
}

export function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}
