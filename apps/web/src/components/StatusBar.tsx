import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';

export default function StatusBar() {
  const { connected, stale, quotes, lastTs, items } = useStore();
  const [health, setHealth] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    const load = () => api.health().then(setHealth).catch(() => undefined);
    load();
    const t = window.setInterval(load, 20000);
    return () => window.clearInterval(t);
  }, []);

  const src = health?.sources?.[0];
  const t = lastTs ? new Date(lastTs).toLocaleTimeString('zh-CN', { hour12: false }) : '--';

  return (
    <div className="statusbar">
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
      <span>缓存 {Object.keys(quotes).length} 只</span>
      <span>更新 {t}</span>
      {stale && <span style={{ color: 'var(--down)' }}>降级中</span>}
      <span style={{ marginLeft: 'auto' }}>
        自选 {items.length} · ↑↓ 切换 · 空格刷新
      </span>
    </div>
  );
}
