import { fetchKlineFull } from '../sources/eastmoney.js';
import { fetchKlineDeep } from '../sources/tencent.js';
import { upsertDailyBars } from '../db/repo.js';
import { query, esc, exec } from '../db/sqlite.js';
import { FULL_HISTORY } from '../config.js';
import type { Bar } from '../types.js';

/**
 * 全市场日 K 回填。
 *
 * 目标：把「所有股票」的日线历史一次性落到本地，之后看图/算指标/回测都走库，
 * 不再依赖上游接口。设计要点：
 *  - 断点续传：每只票一行 kline_sync，进程重启后按它跳过已完成的；
 *  - 限速串行池：同一时刻最多 N 只（默认 3），每只之间留抖动，避免被限流；
 *  - 单只票只打一次请求：东财 push2his 一次返回上市以来全部（前复权），
 *    失败才退回腾讯翻页（640 根/页，最多 40 页）；
 *  - 不预计算指标：5570 只 × 数千根会把库撑到两倍，图表侧本来就是现算 + 回填。
 */

export interface HistoryCoverage {
  /** 库里有日线的股票数 */
  symbols: number;
  /** 日线总根数 */
  bars: number;
  /** 最新一根的日期 */
  newest: string | null;
}

export interface HistoryState {
  running: boolean;
  total: number;
  done: number;
  ok: number;
  failed: number;
  skipped: number;
  concurrency: number;
  current: string;
  startedAt: number | null;
  finishedAt: number | null;
  etaMs: number | null;
  lastError: string;
  coverage: HistoryCoverage;
}

const state: HistoryState = {
  running: false,
  total: 0,
  done: 0,
  ok: 0,
  failed: 0,
  skipped: 0,
  concurrency: 3,
  current: '',
  startedAt: null,
  finishedAt: null,
  etaMs: null,
  lastError: '',
  coverage: { symbols: 0, bars: 0, newest: null },
};

let abortRequested = false;

/** 全表 COUNT 在千万行上不便宜（几百毫秒），缓存一分钟；任务结束时强制刷新一次 */
let coverageAt = 0;
let coverageValue: HistoryCoverage = { symbols: 0, bars: 0, newest: null };

export async function historyCoverage(force = false): Promise<HistoryCoverage> {
  if (!force && coverageAt && Date.now() - coverageAt < 60_000) return coverageValue;
  const rows = await query<{ symbols: number | bigint; bars: number | bigint; newest: string | null }>(
    'SELECT COUNT(DISTINCT symbol) AS symbols, COUNT(*) AS bars, MAX(date) AS newest FROM daily_bar',
  );
  const r = rows[0];
  coverageValue = {
    symbols: Number(r?.symbols ?? 0),
    bars: Number(r?.bars ?? 0),
    newest: r?.newest ?? null,
  };
  coverageAt = Date.now();
  return coverageValue;
}

export async function historyStatus(): Promise<HistoryState> {
  state.coverage = await historyCoverage();
  return { ...state };
}

/** 今天已同步过的票不再重跑（回填是幂等的，重复只为止损） */
function todayStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** 需要回填的名单：没有记录、上次失败、或不是今天同步的 */
async function pendingSymbols(limit: number, refresh: boolean): Promise<string[]> {
  const where = refresh
    ? ''
    : `WHERE k.status IS NULL OR k.status <> 'ok' OR k.updated_at < ${esc(todayStart())}`;
  const cap = limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '';
  const rows = await query<{ symbol: string }>(
    `SELECT s.symbol AS symbol FROM stock s
       LEFT JOIN kline_sync k ON k.symbol = s.symbol
       ${where}
      ORDER BY s.symbol${cap}`,
  );
  return rows.map((r) => String(r.symbol));
}

async function markSync(
  symbol: string,
  status: 'ok' | 'empty' | 'error',
  bars: number,
  source: string,
  error?: string,
  last?: string | null,
): Promise<void> {
  await exec(
    `INSERT OR REPLACE INTO kline_sync (symbol, last_date, bars, source, status, error, updated_at)
     VALUES (${esc(symbol)}, ${last ? esc(last) : 'NULL'}, ${bars}, ${esc(source)},
             ${esc(status)}, ${error ? esc(error.slice(0, 300)) : 'NULL'},
             ${esc(new Date().toISOString())})`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 东财 push2his 偶尔会被 WAF 整段拦掉（连 TCP 都连不上）。
 * 连续失败几次就先停用它 10 分钟，别再给每只票白加一次超时。
 */
let emFails = 0;
let emBlockedUntil = 0;

/** 东财一次拿全量，失败退腾讯翻页；两次都空才算失败 */
async function fetchHistory(symbol: string): Promise<{ bars: Bar[]; source: string }> {
  if (Date.now() >= emBlockedUntil) {
    try {
      const bars = await fetchKlineFull(symbol, 'day', FULL_HISTORY);
      if (bars.length) {
        emFails = 0;
        return { bars, source: 'eastmoney' };
      }
    } catch {
      emFails++;
      if (emFails >= 3) emBlockedUntil = Date.now() + 10 * 60_000;
    }
  }
  const bars = await fetchKlineDeep(symbol, 'day', FULL_HISTORY);
  return { bars, source: 'tencent' };
}

async function syncSymbol(symbol: string): Promise<'ok' | 'empty'> {
  const { bars, source } = await fetchHistory(symbol);
  if (!bars.length) {
    await markSync(symbol, 'empty', 0, source, '接口返回空');
    return 'empty';
  }
  await upsertDailyBars(symbol, bars);
  await markSync(symbol, 'ok', bars.length, source, undefined, bars[bars.length - 1].date);
  return 'ok';
}

export interface StartOptions {
  concurrency?: number;
  limit?: number;
  /** true = 忽略断点，全部重拉（除权后全量校准用） */
  refresh?: boolean;
}

export async function startHistory(opts: StartOptions = {}): Promise<HistoryState> {
  if (state.running) return { ...state, coverage: await historyCoverage() };

  const concurrency = Math.min(8, Math.max(1, Math.floor(opts.concurrency ?? 3)));
  const symbols = await pendingSymbols(Math.floor(opts.limit ?? 0), !!opts.refresh);
  state.running = true;
  state.total = symbols.length;
  state.done = 0;
  state.ok = 0;
  state.failed = 0;
  state.skipped = 0;
  state.concurrency = concurrency;
  state.current = '';
  state.startedAt = Date.now();
  state.finishedAt = null;
  state.etaMs = null;
  state.lastError = '';
  abortRequested = false;

  if (!symbols.length) {
    state.running = false;
    state.finishedAt = Date.now();
    return { ...state, coverage: await historyCoverage(true) };
  }

  void runPool(symbols, concurrency);
  return { ...state, coverage: await historyCoverage() };
}

async function runPool(symbols: string[], concurrency: number): Promise<void> {
  let cursor = 0;
  let consecutiveFail = 0;

  const worker = async () => {
    for (;;) {
      if (abortRequested) return;
      const idx = cursor++;
      if (idx >= symbols.length) return;
      const symbol = symbols[idx];
      state.current = symbol;

      try {
        const r = await syncSymbol(symbol);
        if (r === 'ok') {
          state.ok++;
          consecutiveFail = 0;
        } else {
          state.skipped++;
        }
      } catch (e) {
        state.failed++;
        state.lastError = `${symbol}: ${(e as Error).message}`;
        await markSync(symbol, 'error', 0, '-', (e as Error).message).catch(() => undefined);
        consecutiveFail++;
        // 连续失败说明被限流或源挂了，先停一会儿再继续
        if (consecutiveFail >= 5) {
          await sleep(20_000);
          consecutiveFail = 0;
        }
        // 单只失败不重试第二次：留到下一轮（断点表里是 error，重跑会再排到）
        try {
          await syncSymbol(symbol);
          state.failed--;
          state.ok++;
        } catch {
          /* 第二次还失败就留着 */
        }
      }

      state.done++;
      const elapsed = Date.now() - (state.startedAt ?? Date.now());
      state.etaMs = state.done ? Math.round((elapsed / state.done) * (state.total - state.done)) : null;
      // 注意：不要在这里清 coverage 缓存。COUNT(*) 走全表，几百万行扫一次要几百毫秒，
      // 而前端每 3 秒问一次进度，清了就等于每 3 秒全表扫一遍，会把单线程的库堵死。
      // 每只之间留点空隙，别把上游打满
      await sleep(120 + Math.floor(Math.random() * 120));
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  state.running = false;
  state.current = '';
  state.finishedAt = Date.now();
  await historyCoverage(true);
}

export function stopHistory(): HistoryState {
  abortRequested = true;
  return { ...state };
}
