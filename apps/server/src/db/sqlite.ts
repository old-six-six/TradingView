import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from '../config.js';

let dbc: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stock (
  symbol TEXT PRIMARY KEY,
  code TEXT,
  name TEXT,
  market TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_bar (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_symbol ON daily_bar(symbol, date DESC);

CREATE TABLE IF NOT EXISTS min_bar (
  symbol TEXT NOT NULL,
  ts TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE IF NOT EXISTS indicator_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  ma5 REAL, ma10 REAL, ma20 REAL, ma60 REAL,
  boll_up REAL, boll_mid REAL, boll_dn REAL,
  macd_dif REAL, macd_dea REAL, macd_hist REAL,
  kdj_k REAL, kdj_d REAL, kdj_j REAL,
  rsi6 REAL, rsi12 REAL, atr14 REAL, obv REAL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS watchlist (
  symbol TEXT PRIMARY KEY,
  name TEXT,
  grp TEXT,
  sort_order INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS position (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  shares REAL,
  cost_price REAL,
  open_price REAL,
  opened_at TEXT,
  closed_at TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS alert_rule (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  type TEXT,
  params TEXT,
  enabled INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS alert_log (
  id TEXT PRIMARY KEY,
  rule_id TEXT,
  symbol TEXT,
  triggered_at TEXT,
  price REAL,
  message TEXT
);

CREATE TABLE IF NOT EXISTS setting (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS board (
  code TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT,
  change_pct REAL,
  up_count INTEGER,
  down_count INTEGER,
  updated_at TEXT,
  bars_at TEXT,
  bars_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_board_name ON board(name);

-- 板块指数（由成分股市值加权合成），按 board_code 缓存
CREATE TABLE IF NOT EXISTS board_bar (
  board_code TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (board_code, date)
);

-- 板块 ↔ 个股 的反向索引，用于回答「这只票属于哪些板块」
CREATE TABLE IF NOT EXISTS board_member (
  board_code TEXT NOT NULL,
  symbol TEXT NOT NULL,
  PRIMARY KEY (board_code, symbol)
);
CREATE INDEX IF NOT EXISTS idx_board_member_symbol ON board_member(symbol);
`;

export async function initDb(): Promise<void> {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  dbc = new DatabaseSync(DB_PATH);
  // 注意：本机运行环境不允许 SQLite 创建 WAL/journal 文件，
  // 因此回滚日志放在内存。代价是进程崩溃可能丢最近一次写入，
  // 行情数据可从接口重拉，可接受。
  dbc.exec('PRAGMA journal_mode = MEMORY');
  dbc.exec('PRAGMA synchronous = OFF');
  dbc.exec('PRAGMA foreign_keys = ON');
  dbc.exec(SCHEMA);
  migrate();
}

/** 轻量迁移：老库里缺的列在这里补上（SQLite 的 CREATE TABLE IF NOT EXISTS 不加列） */
function migrate(): void {
  if (!dbc) return;
  const cols = dbc.prepare('PRAGMA table_info(board)').all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => String(c.name)));
  if (!have.has('bars_at')) dbc.exec('ALTER TABLE board ADD COLUMN bars_at TEXT');
  if (!have.has('bars_count')) dbc.exec('ALTER TABLE board ADD COLUMN bars_count INTEGER');
}

export function raw(): DatabaseSync {
  if (!dbc) throw new Error('数据库尚未初始化，请先调用 initDb()');
  return dbc;
}

/** 转义 SQL 字符串字面量 */
export function esc(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function optNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return raw().prepare(sql).all() as unknown as T[];
}

export async function exec(sql: string): Promise<void> {
  raw().exec(sql);
}

/** 批量 upsert，rows 为已转义的 SQL 值元组字符串。分批 + 事务 */
export async function upsertBatch(
  table: string,
  columns: string[],
  rows: string[][],
): Promise<void> {
  if (!rows.length) return;
  const db = raw();
  const CHUNK = 500;
  db.exec('BEGIN');
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const sql =
        `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES\n` +
        part.map((r) => `(${r.join(',')})`).join(',\n');
      db.exec(sql);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export async function closeDb(): Promise<void> {
  if (dbc) {
    dbc.close();
    dbc = null;
  }
}
