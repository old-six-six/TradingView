import { EventEmitter } from 'node:events';
import { getQuotes } from '../sources/gateway.js';
import { POLL_INTERVAL } from '../config.js';
import type { Quote } from '../types.js';

export const bus = new EventEmitter();

let watchProvider: () => Promise<string[]> = async () => [];
let detailSymbol: string | null = null;
let timer: NodeJS.Timeout | null = null;
let tick = 0;
let lastQuotes = new Map<string, Quote>();
let running = false;

export function setWatchProvider(fn: () => Promise<string[]>) {
  watchProvider = fn;
}

export function setDetail(symbol: string | null) {
  detailSymbol = symbol;
}

export function lastSnapshot(): Quote[] {
  return [...lastQuotes.values()];
}

/** 交易时段判断（不含节假日日历，节假日在周末外的交易日会空跑） */
export function isTradingTime(d = new Date()): boolean {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  return (t >= 9 * 60 + 15 && t <= 11 * 60 + 35) || (t >= 12 * 60 + 58 && t <= 15 * 60 + 5);
}

async function pollWatch() {
  try {
    const symbols = await watchProvider();
    if (!symbols.length) return;
    const { quotes, stale } = await getQuotes(symbols);
    if (!quotes.length) return;
    for (const q of quotes) lastQuotes.set(q.symbol, q);
    bus.emit('quotes', { quotes, stale, ts: Date.now() });
  } catch (e) {
    bus.emit('error', (e as Error).message);
  }
}

async function pollDetail() {
  if (!detailSymbol) return;
  try {
    const { quotes } = await getQuotes([detailSymbol]);
    if (!quotes.length) return;
    for (const q of quotes) lastQuotes.set(q.symbol, q);
    bus.emit('quotes', { quotes, stale: false, ts: Date.now() });
  } catch {
    /* 详情失败不影响主循环 */
  }
}

export function startPoller() {
  if (running) return;
  running = true;
  pollWatch();
  timer = setInterval(() => {
    tick++;
    const trading = isTradingTime();
    const interval = Math.max(1, Math.round(POLL_INTERVAL / 1000));
    if (trading) {
      pollDetail();
      if (tick % interval === 0) pollWatch();
    } else if (tick % 30 === 0) {
      pollWatch();
    }
  }, 1000);
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
