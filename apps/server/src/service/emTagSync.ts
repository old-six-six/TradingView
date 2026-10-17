import { fetchStockBoardTags, type EmBoardTag } from '../sources/eastmoney.js';
import { esc, query, upsertBatch } from '../db/sqlite.js';
import { getSetting, setSetting } from '../db/repo.js';
import { boardIndexCount } from './boardSync.js';

/**
 * 科创板 / 北交所的板块补全。
 *
 * 腾讯的板块成分股只覆盖沪深主板与创业板（688、920 开头的票一个都没有），
 * 所以这两个市场在 board_member 里是空白。东财 F10 反过来给的是「个股 → 板块」，
 * 于是这里逐只去问东财，拿到板块名后与腾讯的板块表对齐：
 *   - 对得上（行业名基本完全一致）→ 写 board_member，前端可点开板块 K 线
 *   - 对不上 → 只存 stock_em_tag，前端作为纯标签展示
 *
 * 968 只（科创板 617 + 北交所 351），首次约 2–3 分钟，之后 7 天刷新一次。
 */

const TTL_MS = 7 * 24 * 3600 * 1000;
/** 东财 F10 没有批量接口，靠并发压时间；4 路足够稳，再高容易拿到空响应 */
const CONCURRENCY = 4;
const GAP_MS = 90;

export interface EmTagSyncState {
  running: boolean;
  done: number;
  total: number;
  /** 本次成功拿到标签的股票数 */
  ok: number;
  /** 东财返回空（停牌、退市或代码格式不被认） */
  empty: number;
  failed: number;
  startedAt: number;
  finishedAt: number;
  error: string;
}

let state: EmTagSyncState = {
  running: false,
  done: 0,
  total: 0,
  ok: 0,
  empty: 0,
  failed: 0,
  startedAt: 0,
  finishedAt: 0,
  error: '',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function emTagSyncState(): EmTagSyncState {
  return { ...state };
}

/** 板块名归一化：去掉空白、标点、末尾的 Ⅰ/Ⅱ/Ⅲ 与「概念/板块/指数」 */
export function normalizeBoardName(s: string): string {
  return String(s)
    .replace(/[\s（）()·、,，.．\-—_]/g, '')
    .replace(/[ⅠⅡⅢⅣⅤ]+$/g, '')
    .replace(/I{1,4}$/g, '')
    .replace(/(概念|板块|指数)$/g, '');
}

/**
 * 不是概念、不值得作为标签展示的东财板块：资金持仓、指数成分、风格、
 * 交易属性、财报事件。这些在腾讯体系里多数没有对应板块，混进来只会让
 * 标签行变成噪声。
 */
const NOISE_RE =
  /(重仓|增仓|减仓|新进|加仓|建仓|清仓|持股|持仓|QFII|社保|险资|北向|陆股通|沪股通|深股通|基金|私募|机构|游资|MSCI|富时|罗素|标普|HS300|沪深300|上证50|上证180|上证380|中证|科创50|北证50|创业板指|大盘|中盘|小盘|微盘|成长|百元股|低价股|超跌|绩优|题材股|高送转|破净|破发|破增发|高市净率|低市净率|高市盈率|低市盈率|高股息|高分红|ST|次新股|白马股|龙头|权重股|风格|茅指数|宁组合|热股|热门|人气|活跃股|融资融券|转融券|股权激励|做市|大宗交易|回购|增持|举牌|转债|预增|预减|预盈|预亏|扭亏|中报|年报|季报|业绩|龙虎榜|涨停|跌停|昨日|AH股|红筹|中概)/;

/** 是否值得作为纯标签展示 */
function keepAsTag(name: string): boolean {
  if (!name) return false;
  if (NOISE_RE.test(name)) return false;
  // 过于宽泛或纯代码式的「XX板块」
  if (/^(A股|B股|H股|其他)$/.test(name)) return false;
  if (/^[A-Z]{1,2}\d+_?$/.test(name)) return false;
  return true;
}

/** 腾讯板块名 → 板块记录。同名时行业优先，其次概念，最后地域 */
async function loadBoardNameMap(): Promise<Map<string, { code: string; kind: string }>> {
  const rows = await query<{ code: string; name: string; kind: string }>(
    'SELECT code, name, kind FROM board',
  );
  const order: Record<string, number> = { hy: 0, gn: 1, dy: 2 };
  const map = new Map<string, { code: string; kind: string }>();
  for (const r of rows) {
    const k = normalizeBoardName(r.name);
    if (!k) continue;
    const cur = map.get(k);
    if (!cur || (order[r.kind] ?? 9) < (order[cur.kind] ?? 9)) {
      map.set(k, { code: r.code, kind: r.kind });
    }
  }
  return map;
}

/** 需要补板块的股票：科创板 + 北交所 */
async function targetSymbols(): Promise<string[]> {
  const rows = await query<{ symbol: string }>(
    `SELECT symbol FROM stock
      WHERE symbol LIKE 'sh68%' OR symbol LIKE 'bj%'
      ORDER BY symbol`,
  );
  return rows.map((r) => r.symbol);
}

/** 到点则后台刷新，不阻塞调用方 */
export async function ensureEmTagIndex(force = false): Promise<void> {
  if (state.running) return;
  const at = Number(await getSetting('em_tag_at')) || 0;
  if (!force && Date.now() - at < TTL_MS) return;
  void runSync();
}

async function runSync(): Promise<void> {
  // 板块表为空说明腾讯板块还没拉到，匹配会全部落空，等下一轮
  const boardCount = await boardIndexCount();
  if (!boardCount) {
    console.log('[em-tag] 腾讯板块索引为空，跳过本轮');
    return;
  }

  state = {
    running: true,
    done: 0,
    total: 0,
    ok: 0,
    empty: 0,
    failed: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    error: '',
  };

  try {
    const symbols = await targetSymbols();
    if (!symbols.length) throw new Error('没有需要补板块的股票');
    const nameMap = await loadBoardNameMap();
    state.total = symbols.length;
    console.log(`[em-tag] 开始补板块：${symbols.length} 只，腾讯板块 ${nameMap.size} 个名字可对齐`);

    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= symbols.length) return;
        const symbol = symbols[i];
        try {
          const tags = await fetchStockBoardTags(symbol);
          if (!tags.length) {
            state.empty++;
          } else {
            await saveTags(symbol, tags, nameMap);
            state.ok++;
          }
        } catch {
          state.failed++;
        }
        state.done++;
        if (state.done % 50 === 0) {
          console.log(`[em-tag] ${state.done}/${state.total}，成功 ${state.ok}，空 ${state.empty}`);
        }
        await sleep(GAP_MS);
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await setSetting('em_tag_at', String(Date.now()));
    console.log(
      `[em-tag] 完成 ${state.done} 只（成功 ${state.ok}，空 ${state.empty}，失败 ${state.failed}），` +
        `耗时 ${Date.now() - state.startedAt}ms`,
    );
  } catch (e) {
    state.error = (e as Error).message;
    console.error('[em-tag] 失败', state.error);
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
  }
}

/** 落库：全部标签写 stock_em_tag，能对上腾讯板块的同时写 board_member */
async function saveTags(
  symbol: string,
  tags: EmBoardTag[],
  nameMap: Map<string, { code: string; kind: string }>,
): Promise<void> {
  const now = new Date().toISOString();
  const tagRows: string[][] = [];
  const memberRows: string[][] = [];

  for (const t of tags) {
    const hit = nameMap.get(normalizeBoardName(t.name));
    tagRows.push([
      esc(symbol),
      esc(t.name),
      String(t.rank),
      hit ? esc(hit.code) : 'NULL',
      esc(now),
    ]);
    if (hit) memberRows.push([esc(hit.code), esc(symbol)]);
  }

  await upsertBatch(
    'stock_em_tag',
    ['symbol', 'name', 'rank', 'board_code', 'updated_at'],
    tagRows,
  );
  if (memberRows.length) {
    await upsertBatch('board_member', ['board_code', 'symbol'], memberRows);
  }
}

/** 某只票的纯标签（对不上腾讯板块的那部分） */
export async function tagsOfStock(symbol: string): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT name FROM stock_em_tag
      WHERE symbol = ${esc(symbol)} AND board_code IS NULL
      ORDER BY rank, name`,
  );
  // 东财的二级/三级行业常成对出现（燃气Ⅱ / 燃气Ⅲ），归一化后同名只留第一个
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!keepAsTag(r.name)) continue;
    const key = normalizeBoardName(r.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r.name);
  }
  return out;
}

/** 标签同步覆盖面，给状态栏 / 排障用 */
export async function emTagCoverage(): Promise<{ symbols: number; tags: number; linked: number }> {
  const rows = await query<{ symbols: number; tags: number; linked: number }>(
    `SELECT COUNT(DISTINCT symbol) AS symbols,
            COUNT(*) AS tags,
            COUNT(board_code) AS linked
       FROM stock_em_tag`,
  );
  const r = rows[0];
  return {
    symbols: Number(r?.symbols ?? 0),
    tags: Number(r?.tags ?? 0),
    linked: Number(r?.linked ?? 0),
  };
}
