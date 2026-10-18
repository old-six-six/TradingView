import type { FastifyInstance } from 'fastify';
import { systemRoutes } from './system.js';
import { quoteRoutes } from './quote.js';
import { watchRoutes } from './watch.js';
import { positionRoutes } from './positions.js';
import { marketRoutes } from './market.js';
import { historyRoutes } from './history.js';

/**
 * 路由总装。
 *
 * 以前 500 多行全塞在这个文件里，行情、自选、板块、持仓混在一起；
 * 现在按领域分文件，这个文件只负责注册，新增接口一眼能看出该往哪加。
 */
export async function apiRoutes(app: FastifyInstance) {
  await systemRoutes(app);
  await quoteRoutes(app);
  await watchRoutes(app);
  await positionRoutes(app);
  await marketRoutes(app);
  await historyRoutes(app);
}
