import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { backToChart } from '../nav';

export default function StatusBar() {
  const { connected, stale, quotes, lastTs, items, market, marketStat } = useStore();
  const [health, setHealth] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    const load = () => api.health().then(setHealth).catch(() => undefined);
    load();
    const t = window.setInterval(load, 20000);
    return () => window.clearInterval(t);
  }, []);

  const src = health?.sources?.[0];
  const t = lastTs ? new Date(lastTs).toLocaleTimeString('zh-CN', { hour12: false }) : '--';
  const listTs = marketStat?.updatedAt
    ? new Date(marketStat.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '';

  return (
    <div className="statusbar">
      {market ? (
        <>
          <span className="sb-back" onClick={backToChart} title="返回图表（Esc）">
            ← 返回图表
          </span>
          <span className="sb-cur">{marketStat?.label ?? market}</span>
          {marketStat?.loading && <span>加载中…</span>}
          {marketStat && !marketStat.loading && (
            <>
              <span>{marketStat.count} 只</span>
              <span className="up">涨 {marketStat.up}</span>
              <span className="down">跌 {marketStat.down}</span>
            </>
          )}
          {listTs && <span>更新 {listTs}</span>}
          <span className="sb-sep" />
        </>
      ) : null}

      <a
        className="sb-link"
        href="https://l2.10jqka.com.cn/hottrack/public/dist/index.html#/marketCondition"
        target="_blank"
        rel="noopener noreferrer"
        title="同花顺 · 市场情绪（新窗口打开）"
      >
        同花顺·市场情绪 ↗
      </a>
      <span>
        <span
          className="status-dot"
          style={{ background: connected ? 'var(--down)' : 'var(--up)' }}
        />
        {connected ? '行情已连接' : '行情未连接'}
      </span>
      <span>数据源 {src?.name ?? '--'}</span>
      <span>延迟 {src?.latencyMs ? `${src.latencyMs}ms` : '--'}</span>
      <span>股票库 {health?.stocks ?? 0} 只</span>
      {!market && <span>缓存 {Object.keys(quotes).length} 只</span>}
      {!market && <span>更新 {t}</span>}
      {stale && <span style={{ color: 'var(--down)' }}>降级中</span>}
      <span style={{ marginLeft: 'auto' }}>
        {market ? 'Esc 返回 · 点任意行看 K 线' : `自选 ${items.length} · ↑↓ 切换 · 空格刷新`}
      </span>
    </div>
  );
}
