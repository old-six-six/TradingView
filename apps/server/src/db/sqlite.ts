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
