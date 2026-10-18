import { useEffect, useState } from 'react';
import { api, type HealthInfo, type HistoryState } from '../api';
import { useStore } from '../store';
import { backFromMarket } from '../nav';

/** 毫秒 → 12:34 这样的短耗时，ETA 用 */
function shortMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** 千万级根数用中文单位，别把状态栏撑长 */
function shortCount(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(0)} 万`;
  return String(n);
}

export default function StatusBar() {
  const { connected, stale, quotes, lastTs, market, marketStat } = useStore();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [hist, setHist] = useState<HistoryState | null>(null);

  useEffect(() => {
    const load = () => api.health().then(setHealth).catch(() => undefined);
    load();
    const t = window.setInterval(load, 20000);
    return () => window.clearInterval(t);
  }, []);

  /**
   * 历史回填进度：跑着的时候 5 秒刷一次，闲下来 30 秒一次就够
   * （服务端那边 COUNT 也有缓存，不会每次都扫全表）。
   */
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      try {
        const s = await api.historyStatus();
        if (!alive) return;
        setHist(s);
        timer = window.setTimeout(load, s.running ? 3000 : 30000);
      } catch {
        if (alive) timer = window.setTimeout(load, 30000);
      }
    };
    void load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  const stocks = Number(health?.stocks ?? 0);
  const covered = hist?.coverage.symbols ?? 0;
  const missing = Math.max(0, stocks - covered);

  const toggleHistory = async () => {
    if (!hist) return;
    try {
      const s = hist.running ? await api.stopHistory() : await api.startHistory({ concurrency: 3 });
      setHist(s);
    } catch {
      /* 失败就等下一轮轮询 */
    }
  };

  const src = health?.sources?.[0];
  const t = lastTs ? new Date(lastTs).toLocaleTimeString('zh-CN', { hour12: false }) : '--';
  const listTs = marketStat?.updatedAt
    ? new Date(marketStat.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '';

  return (
    <div className="statusbar">
      {market ? (
        <>
          <span className="sb-back" onClick={backFromMarket} title="返回上一层（Esc）">
            ← 返回
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
      {hist && (
        <span
          className={`sb-hist${hist.running ? ' on' : ''}${missing && !hist.running ? ' todo' : ''}`}
          onClick={hist.running || missing ? toggleHistory : undefined}
          title={
            hist.running
              ? `正在回填 ${hist.done}/${hist.total}，当前 ${hist.current || '--'}，点击暂停`
              : missing
                ? `本地已存 ${covered} 只 / ${shortCount(hist.coverage.bars)} 根，点击补齐其余 ${missing} 只`
                : `本地已存 ${covered} 只 / ${shortCount(hist.coverage.bars)} 根，最新 ${hist.coverage.newest ?? '--'}`
          }
        >
          {hist.running
            ? `历史 ${hist.done}/${hist.total} · ${hist.etaMs != null ? shortMs(hist.etaMs) : '--'}`
            : missing
              ? `历史 ${covered}/${stocks} ▸ 回填`
              : `历史 ${covered} 只 · ${shortCount(hist.coverage.bars)} 根`}
        </span>
      )}
      {!market && <span>缓存 {Object.keys(quotes).length} 只</span>}
      {!market && <span>更新 {t}</span>}
      {stale && <span style={{ color: 'var(--down)' }}>降级中</span>}
      {market && (
        <span style={{ marginLeft: 'auto' }}>Esc 返回 · 点任意行看 K 线</span>
      )}
    </div>
  );
}
