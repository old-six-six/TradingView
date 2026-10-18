/**
 * 全市场日 K 回填 CLI（服务没起的时候用）。
 *
 *   npm run backfill -- --limit=100 --concurrency=3
 *   npm run backfill -- --refresh          # 忽略断点，全部重拉
 *   npm run backfill -- --status           # 只看当前覆盖情况
 *
 * 服务在跑的时候建议走接口而不是这个脚本：两个进程同时写同一个
 * SQLite 会互相等锁（虽然有 busy_timeout 兜着，但没必要）。
 */
import { initDb, closeDb } from '../db/sqlite.js';
import { historyStatus, startHistory } from '../service/history.js';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes(`--${name}`) ? '1' : undefined;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const hms = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

async function main() {
  await initDb();

  if (arg('status')) {
    const st = await historyStatus();
    console.log(
      `覆盖 ${st.coverage.symbols} 只 / ${st.coverage.bars} 根，最新 ${st.coverage.newest ?? '--'}`,
    );
    return;
  }

  const started = await startHistory({
    concurrency: Number(arg('concurrency')) || 3,
    limit: Number(arg('limit')) || 0,
    refresh: !!arg('refresh'),
  });
  console.log(`开始回填 ${started.total} 只，并发 ${started.concurrency}`);
  if (!started.total) {
    console.log('没有需要回填的票（全部已同步）');
    return;
  }

  let lastLine = '';
  for (;;) {
    const st = await historyStatus();
    const pct = st.total ? ((st.done / st.total) * 100).toFixed(1) : '0.0';
    const line =
      `${st.done}/${st.total} (${pct}%)  成功 ${st.ok}  失败 ${st.failed}  ` +
      `当前 ${st.current || '--'}  剩余 ${st.etaMs != null ? hms(st.etaMs) : '--'}`;
    if (line !== lastLine) {
      process.stdout.write(`\r${line}`);
      lastLine = line;
    }
    if (!st.running) {
      process.stdout.write('\n');
      console.log(
        `完成：成功 ${st.ok}、失败 ${st.failed}、空数据 ${st.skipped}，` +
          `覆盖 ${st.coverage.symbols} 只 / ${st.coverage.bars} 根`,
      );
      if (st.lastError) console.log(`最后一条错误：${st.lastError}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main()
  .catch((e) => {
    console.error('回填失败：', (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
