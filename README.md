# TradingView · 本地看盘

Mac M1 上的个人 A 股看盘终端。单仓两应用：

| 目录 | 说明 |
|---|---|
| `apps/server` | Fastify + `node:sqlite`，负责行情采集、指标计算、REST/WS 服务 |
| `apps/web` | Vite + React + lightweight-charts v5，负责界面 |
| `data/tv.db` | SQLite 数据文件（不入库） |

## 启动

```bash
npm install
npm run dev
```

- 前端 http://127.0.0.1:5273
- 后端 http://127.0.0.1:3111

首次启动会自动写入 6 只默认自选、拉取全市场股票列表、同步日 K 并计算指标，约 30–60 秒。

单独跑（推荐开两个终端，日志不混）：

```bash
npm run dev:server
npm run dev:web
npm run init:data            # 手动初始化：股票列表 + 自选 + 日K + 指标
```

> 脚本内部直接 `node <入口文件>`，不依赖 `node_modules/.bin`。若 `npm run` 报找不到模块，先确认根目录 `npm install` 已跑完。

## 已实现（P0–P2）

- **P0** 工程骨架、建表、腾讯行情适配器、日 K 落库、K 线渲染
- **P1** 3 秒实时轮询、WebSocket 推送、自选列表红绿跳动、五档盘口、分时图
- **P2** 指标引擎（MA/BOLL/MACD/KDJ/RSI/ATR/OBV）、多周期切换、副图、指标落库
- **日 K 全部历史**：自上市首日起落库（600685 7651 根，可回溯到 1993-10-28），指标按全量历史重算

## 交互

| 操作 | 效果 |
|---|---|
| `↑` `↓` | 切换自选股 |
| 顶部搜索框 | 按代码/名称搜索，回车加入自选并打开 |
| 周期标签 | 分时 / 5m / 15m / 30m / 60m / 日K / 周K / 月K |
| MACD / KDJ / RSI | 切换副图指标，分钟与日线周期均可用 |
| 图例里的 MA5/MA10/MA20/MA60 | 点击单条均线隐藏/显示，隐藏后显示为 `--` |
| 周期栏右侧「均线」 | 一键全隐/全显四条均线；设置记在浏览器本地，刷新后保持 |
| 鼠标十字光标 | 图表左上角图例联动显示该根的开高低收、涨跌幅、量、均线与指标值 |

## 数据源

| 源 | 用途 | 状态 |
|---|---|---|
| 腾讯 `qt.gtimg.cn` | 实时快照 + 五档 | 主源，3 秒轮询；必须带 UA + https |
| 东方财富 `push2his` | 日/周/月 K **全部历史**（前复权） | 主源，单只最长约 8500 根 |
| 腾讯 `fqkline` | 日/周/月 K（前复权） | 备源，**单次硬上限 640 根** |
| 腾讯 `minute/query` | 当日 1 分钟分时 | 分时图数据源 |
| 新浪 `getKLineData` | 5/15/30/60 分钟 K，1023 根 | 分钟周期主源，45 秒缓存 |
| 新浪 `Market_Center` | 全市场列表（100 只/页） | 用于搜索与排行 |
| 东方财富 `push2`（实时/板块） | — | 已失效，未接入；但 `push2his` 历史线可用 |

> 东财与腾讯的前复权口径一致：同一交易日开高低收量逐字段相同（已用 600685 交叉核对），可互相替代。

## 已知限制

- **无 Level-2**：十档、逐笔成交拿不到，只有五档。
- **超长历史会出现负价**：前复权按最新价倒推，个别高送转个股的早年价格会被压到 0 或负值（如 000001 的 1991 年），这是复权口径的正常结果，不是脏数据。价格恰为 0 的那一根会被丢弃（无法在图上表达）。
- **分钟 K 不复权**：新浪分钟线是不复权口径，遇到除权日会有跳空；短周期影响小，日 K 走东财前复权。
- **分钟 K 不落库**：每次进周期从源站拉 1023 根 + 45 秒内存缓存，盘中最后一根未做实时刷新。
- **接口无 SLA**：连续失败 5 次触发 60 秒熔断，降级到本地缓存并在界面标记「数据延迟」。
- **非交易日**：轮询自动降频到 30 秒一次，界面显示的是最近收盘数据。

## 环境相关的两处取舍

1. **存储用 `node:sqlite` 而非 DuckDB**：`@duckdb/node-api` 的 darwin-arm64 包在本机装不上（原生库损坏且无法替换）。SQLite 是 Node 22 内置，零依赖，当前数据量下性能足够。
2. **SQLite 跑 `journal_mode = MEMORY`**：本机沙箱禁止创建 WAL/journal 文件，否则报 `disk I/O error`。代价是进程崩溃可能丢最后一次写入，行情可重拉。

## API

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 健康检查、数据源状态、熔断标记 |
| `GET /api/quote?symbols=a,b` | 实时行情（含五档） |
| `GET /api/kline?symbol=&period=&limit=` | K 线，period 支持 day/week/month/m1/m5/m15/m30/m60；`limit=all` 或 `limit=0` 取上市以来全部 |
| `GET /api/minute?symbol=` | 当日分时 |
| `GET /api/indicators?symbol=&limit=` | 指标序列，同样支持 `limit=all` |
| `GET /api/rank?sort=changePct&dir=desc&limit=50` | 全市场排行（变动率/成交额/换手等） |
| `GET /api/search?q=` | 代码或名称模糊搜索，最多 20 条 |
| `GET /api/watchlist` | 自选列表（含实时行情） |
| `POST /api/watchlist` | 添加自选，body `{ symbol }` |
| `DELETE /api/watchlist/:symbol` | 移除自选 |
| `GET /api/positions` | 持仓列表（含浮动盈亏） |
| `POST /api/positions` | 新增持仓，body `{ symbol, shares, cost }` |
| `DELETE /api/positions/:id` | 删除持仓 |
| `POST /api/detail` | 切换当前详情报价票，body `{ symbol }` |
| `WS /ws` | 连接即推 snapshot，之后按 3 秒推 quote |
