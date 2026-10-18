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

/** 没有指定分组的票都归这里，也是唯一不能删的文件夹 */
export const DEFAULT_FOLDER = '默认';
const FOLDER_NAME_MAX = 16;

export interface WatchFolder {
  name: string;
  count: number;
}

/** 文件夹名做基本清洗：去首尾空白、连续空格压成一个、限长 */
export function normalizeFolderName(raw: unknown): string {
  const name = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!name) throw new Error('文件夹名称不能为空');
  if ([...name].length > FOLDER_NAME_MAX) throw new Error(`文件夹名称最多 ${FOLDER_NAME_MAX} 个字`);
  return name;
}

/** 文件夹清单，顺带带上各自的票数（空文件夹也要返回，否则刚建的会看不见） */
export async function listFolders(): Promise<WatchFolder[]> {
  const rows = await query<{ name: string; count: number | bigint }>(
    `SELECT f.name AS name,
            (SELECT COUNT(*) FROM watchlist w WHERE w.grp = f.name) AS count
       FROM watch_folder f
      ORDER BY f.sort_order ASC, f.name ASC`,
  );
  return rows.map((r) => ({ name: String(r.name), count: num(r.count) }));
}

export async function addFolder(raw: unknown): Promise<string> {
  const name = normalizeFolderName(raw);
  const dup = await query<{ c: number | bigint }>(
    `SELECT COUNT(*) AS c FROM watch_folder WHERE name = ${esc(name)}`,
  );
  if (num(dup[0]?.c) > 0) throw new Error('同名文件夹已存在');
  const rows = await query<{ m: number | bigint }>(
    'SELECT COALESCE(MAX(sort_order), 1) + 1 AS m FROM watch_folder',
  );
  const order = num(rows[0]?.m) || 2;
  await exec(
    `INSERT INTO watch_folder (name, sort_order, created_at)
     VALUES (${esc(name)}, ${order}, ${esc(new Date().toISOString())})`,
  );
  return name;
}

/** 删文件夹只删壳，里面的票退回「默认」，不会跟着消失 */
export async function removeFolder(raw: unknown): Promise<void> {
  const name = normalizeFolderName(raw);
  if (name === DEFAULT_FOLDER) throw new Error(`「${DEFAULT_FOLDER}」文件夹不能删除`);
  await exec(`UPDATE watchlist SET grp = ${esc(DEFAULT_FOLDER)} WHERE grp = ${esc(name)}`);
  await exec(`DELETE FROM watch_folder WHERE name = ${esc(name)}`);
}

/** 文件夹不存在就顺手建出来，免得多一次「先建后放」的交互 */
async function ensureFolder(name: string): Promise<void> {
  const rows = await query<{ c: number | bigint }>(
    `SELECT COUNT(*) AS c FROM watch_folder WHERE name = ${esc(name)}`,
  );
  if (num(rows[0]?.c) > 0) return;
  await addFolder(name);
}

export async function addWatch(
  symbol: string,
  name: string,
  grp: string = DEFAULT_FOLDER,
): Promise<void> {
  const folder = normalizeFolderName(grp);
  await ensureFolder(folder);
  const rows = await query<{ m: number }>('SELECT COALESCE(MAX(sort_order), 0) + 1 AS m FROM watchlist');
  const order = num(rows[0]?.m) || 1;
  await exec(
    `INSERT OR REPLACE INTO watchlist (symbol, name, grp, sort_order, created_at)
     VALUES (${esc(symbol)}, ${esc(name)}, ${esc(folder)}, ${order}, ${esc(new Date().toISOString())})`,
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
