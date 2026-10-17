import {
  fetchBoardList,
  fetchBoardMembers,
  type BoardInfo,
  type BoardKind,
} from '../sources/tencentBoard.js';
import { esc, raw, query, upsertBatch } from '../db/sqlite.js';
import { getSetting, setSetting } from '../db/repo.js';

/**
 * 板块反向索引（个股 → 板块）。
 *
 * 腾讯没有「查某只票属于哪些板块」的接口，只有「板块 → 成分股」，
 * 所以这里把全部板块的成分股拉一遍落库，之后按 symbol 查索引。
 * 全量约 870 个板块、7 万条关系，首次约 3–5 分钟，之后 12 小时刷新一次。
 */

const TTL_MS = 12 * 3600 * 1000;
const GAP_MS = 40;

export interface BoardSyncState {
  running: boolean;
  done: number;
  total: number;
  startedAt: number;
  finishedAt: number;
  error: string;
}

let state: BoardSyncState = {
  running: false,
  done: 0,
  total: 0,
  startedAt: 0,
  finishedAt: 0,
  error: '',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function boardSyncState(): BoardSyncState {
  return { ...state };
}

/** 索引是否已可用（表里有数据即可，不要求本轮已完成） */
export async function boardIndexCount(): Promise<number> {
  const rows = await query<{ n: number }>('SELECT COUNT(*) AS n FROM board_member');
  return Number(rows[0]?.n ?? 0);
}

/** 到点则后台刷新，不阻塞调用方 */
export async function ensureBoardIndex(force = false): Promise<void> {
  if (state.running) return;
  const at = Number(await getSetting('board_index_at')) || 0;
  if (!force && Date.now() - at < TTL_MS) return;
  void runSync();
}

async function runSync(): Promise<void> {
  state = { running: true, done: 0, total: 0, startedAt: Date.now(), finishedAt: 0, error: '' };
  try {
    const list = await fetchBoardList();
    if (!list.length) throw new Error('板块列表为空');
    const now = new Date().toISOString();
    await upsertBatch(
      'board',
      ['code', 'name', 'kind', 'change_pct', 'up_count', 'down_count', 'updated_at'],
      list.map((b) => [
        esc(b.code),
        esc(b.name),
        esc(b.kind),
        String(b.changePct),
        String(b.up),
        String(b.down),
        esc(now),
      ]),
    );
    state.total = list.length;
    console.log(`[board] 板块列表 ${list.length} 个，开始建成分索引`);

    raw().exec('DELETE FROM board_member');
    for (const b of list) {
      try {
        const members = await fetchBoardMembers(b.code, b.kind);
        if (members.length) {
          await upsertBatch(
            'board_member',
            ['board_code', 'symbol'],
            members.map((s) => [esc(b.code), esc(s)]),
          );
        }
      } catch {
        /* 单个板块失败不影响整体，下一轮刷新会补 */
      }
      state.done++;
      await sleep(GAP_MS);
    }
    await setSetting('board_index_at', String(Date.now()));
    console.log(`[board] 成分索引完成，${state.done} 个板块，耗时 ${Date.now() - state.startedAt}ms`);
  } catch (e) {
    state.error = (e as Error).message;
    console.error('[board] 建索引失败', state.error);
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
  }
}

export interface StockBoard {
  code: string;
  name: string;
  kind: BoardKind;
  /** 实时涨跌幅，取不到时用索引里的快照 */
  changePct: number;
}

/** 某只票所属的全部板块，按 行业 → 地域 → 概念 排序 */
export async function boardsOfStock(symbol: string): Promise<StockBoard[]> {
  const rows = await query<{
    code: string;
    name: string;
    kind: string;
    change_pct: number;
  }>(
    `SELECT b.code AS code, b.name AS name, b.kind AS kind, b.change_pct AS change_pct
       FROM board_member m JOIN board b ON b.code = m.board_code
      WHERE m.symbol = ${esc(symbol)}`,
  );
  const order: Record<string, number> = { hy: 0, dy: 1, gn: 2 };
  return rows
    .map((r) => ({
      code: r.code,
      name: r.name,
      kind: r.kind as BoardKind,
      changePct: Number(r.change_pct) || 0,
    }))
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.code.localeCompare(b.code));
}
