import { useStore } from '../store';
import { cls, fmtNum, fmtPct } from '../fmt';

export default function WatchList() {
  const { items, quotes, selected, select } = useStore();

  return (
    <div className="sidebar">
      <div className="panel-title">
        <span>自选股</span>
        <span>{items.length} 只</span>
      </div>
      <div className="watch-list">
        {items.length === 0 && <div className="empty">暂无自选</div>}
        {items.map((it) => {
          const q = quotes[it.symbol] ?? it.quote;
          const pct = q?.changePct ?? 0;
          return (
            <div
              key={it.symbol}
              className={`watch-item${selected === it.symbol ? ' active' : ''}`}
              onClick={() => select(it.symbol)}
            >
              <div className="watch-row">
                <span className="watch-name">{q?.name || it.name}</span>
                <span className={`num ${cls(pct)}`}>{q ? fmtNum(q.price) : '--'}</span>
              </div>
              <div className="watch-sub">
                <span className="num">{it.symbol.slice(2)}</span>
                <span className={`num ${cls(pct)}`}>{q ? fmtPct(pct) : ''}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
