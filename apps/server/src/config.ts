import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** apps/server/src → 项目根 */
export const ROOT = path.resolve(here, '../../..');
export const DATA_DIR = path.join(ROOT, 'data');

export const DB_PATH = process.env.TV_DB ?? path.join(DATA_DIR, 'tv.db');

export const PORT = Number(process.env.TV_PORT ?? 3111);

/** 自选/持仓轮询间隔（毫秒） */
export const POLL_INTERVAL = 3000;
/** 当前打开票的详情轮询间隔 */
export const DETAIL_INTERVAL = 1000;
/** 全市场排行刷新间隔 */
export const RANK_INTERVAL = 60_000;

/** 腾讯单批最大股票数 */
export const BATCH_SIZE = 60;

/** 日 K 拉取的默认根数 */
export const DAILY_BARS = 640;
