import { query, exec, esc, upsertBatch, num } from './sqlite.js';
import { pinyinInitials, pinyinInitialsAlt } from '../service/pinyin.js';
import type { Bar, IndicatorSeries, StockInfo } from '../types.js';

export interface WatchItem {
  symbol: string;
  name: string;
  grp: string;
  sort_order: number;
}

export interface PositionRow {
  id: string;
  symbol: string;
  shares: number;
  cost_price: number;
  open_price: number;
  opened_at: string;
  closed_at: string | null;
  note: string | null;
}

export async function upsertStocks(stocks: StockInfo[]): Promise<void> {
  const now = new Date().toISOString();
  const rows = stocks.map((s) => [
    esc(s.symbol),
    esc(s.code),
    esc(s.name),
    esc(s.market),
    // 名称变了拼音也得跟着变，所以每次都一并写入
    esc(pinyinInitials(s.name)),
    pinyinInitialsAlt(s.name) ? esc(pinyinInitialsAlt(s.name)) : 'NULL',
    esc(now),
  ]);
  await upsertBatch('stock', ['symbol', 'code', 'name', 'market', 'py', 'py2', 'updated_at'], rows);
}

export async function getStock(symbol: string): Promise<StockInfo | null> {
  const rows = await query<{ symbol: string; code: string; name: string; market: string }>(
    `SELECT symbol, code, name, market FROM stock WHERE symbol = ${esc(symbol)} LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function stockCount(): Promise<number> {
  const rows = await query<{ c: number }>('SELECT COUNT(*) AS c FROM stock');
  return num(rows[0]?.c);
}

export async function upsertDailyBars(symbol: string, bars: Bar[]): Promise<void> {
  const rows = bars.map((b) => [
    esc(symbol),
    esc(b.date),
    String(b.open),
    String(b.high),
    String(b.low),
    String(b.close),
    String(b.volume),
  ]);
  await upsertBatch('daily_bar', ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'], rows);
}

/** limit <= 0 表示取全部（自上市以来） */
export async function getDailyBars(symbol: string, limit = 640): Promise<Bar[]> {
  const tail = limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '';
  const rows = await query<Record<string, unknown>>(
    `SELECT date, open, high, low, close, volume FROM daily_bar
     WHERE symbol = ${esc(symbol)} ORDER BY date DESC${tail}`,
  );
  return rows
    .map((r) => ({
      date: String(r.date),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      volume: num(r.volume),
    }))
    .reverse();
}

export async function lastBarDate(symbol: string): Promise<string | null> {
  const rows = await query<{ d: string }>(
    `SELECT MAX(date) AS d FROM daily_bar WHERE symbol = ${esc(symbol)}`,
  );
  return rows[0]?.d ?? null;
}

export async function upsertIndicators(symbol: string, s: IndicatorSeries): Promise<void> {
  const rows: string[][] = [];
  const n = (v: number) => (Number.isFinite(v) ? String(v) : 'NULL');
  for (let i = 0; i < s.date.length; i++) {
    rows.push([
      esc(symbol),
      esc(s.date[i]),
      n(s.ma5[i]), n(s.ma10[i]), n(s.ma20[i]), n(s.ma60[i]),
      n(s.bollUp[i]), n(s.bollMid[i]), n(s.bollDn[i]),
      n(s.macdDif[i]), n(s.macdDea[i]), n(s.macdHist[i]),
      n(s.kdjK[i]), n(s.kdjD[i]), n(s.kdjJ[i]),
      n(s.rsi6[i]), n(s.rsi12[i]), n(s.atr14[i]), n(s.obv[i]),
    ]);
  }
  await upsertBatch(
    'indicator_daily',
    [
      'symbol', 'date',
      'ma5', 'ma10', 'ma20', 'ma60',
      'boll_up', 'boll_mid', 'boll_dn',
      'macd_dif', 'macd_dea', 'macd_hist',
      'kdj_k', 'kdj_d', 'kdj_j',
      'rsi6', 'rsi12', 'atr14', 'obv',
    ],
    rows,
  );
}

/** limit <= 0 表示取全部 */
export async function getIndicators(symbol: string, limit = 640): Promise<Record<string, unknown>[]> {
  const tail = limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '';
  return query(
    `SELECT * FROM indicator_daily WHERE symbol = ${esc(symbol)}
     ORDER BY date DESC${tail}`,
  );
}

export async function listWatchlist(): Promise<WatchItem[]> {
  return query<WatchItem>(
    'SELECT symbol, name, grp, sort_order FROM watchlist ORDER BY sort_order ASC, symbol ASC',
  );
}

export async function addWatch(symbol: string, name: string, grp = '默认'): Promise<void> {
  const rows = await query<{ m: number }>('SELECT COALESCE(MAX(sort_order), 0) + 1 AS m FROM watchlist');
  const order = num(rows[0]?.m) || 1;
  await exec(
    `INSERT OR REPLACE INTO watchlist (symbol, name, grp, sort_order, created_at)
     VALUES (${esc(symbol)}, ${esc(name)}, ${esc(grp)}, ${order}, ${esc(new Date().toISOString())})`,
  );
}

export async function removeWatch(symbol: string): Promise<void> {
  await exec(`DELETE FROM watchlist WHERE symbol = ${esc(symbol)}`);
}

export async function reorderWatch(symbols: string[]): Promise<void> {
  for (let i = 0; i < symbols.length; i++) {
    await exec(`UPDATE watchlist SET sort_order = ${i + 1} WHERE symbol = ${esc(symbols[i])}`);
  }
}

export async function listPositions(): Promise<PositionRow[]> {
  return query<PositionRow>(
    'SELECT id, symbol, shares, cost_price, open_price, opened_at, closed_at, note FROM position WHERE closed_at IS NULL ORDER BY opened_at DESC',
  );
}

export async function addPosition(p: {
  id: string;
  symbol: string;
  shares: number;
  costPrice: number;
  openPrice: number;
  openedAt: string;
  note?: string;
}): Promise<void> {
  await exec(
    `INSERT OR REPLACE INTO position (id, symbol, shares, cost_price, open_price, opened_at, closed_at, note)
     VALUES (${esc(p.id)}, ${esc(p.symbol)}, ${p.shares}, ${p.costPrice}, ${p.openPrice},
             ${esc(p.openedAt)}, NULL, ${p.note ? esc(p.note) : 'NULL'})`,
  );
}

export async function closePosition(id: string): Promise<void> {
  await exec(`UPDATE position SET closed_at = ${esc(new Date().toISOString())} WHERE id = ${esc(id)}`);
}

export async function getSetting(k: string): Promise<string | null> {
  const rows = await query<{ v: string }>(`SELECT v FROM setting WHERE k = ${esc(k)}`);
  return rows[0]?.v ?? null;
}

export async function setSetting(k: string, v: string): Promise<void> {
  await exec(`INSERT OR REPLACE INTO setting (k, v) VALUES (${esc(k)}, ${esc(v)})`);
}
