import { useMemo, useState } from 'react';
import { api, type WatchItem } from '../api';
import { useStore } from '../store';
import { cls, fmtNum, fmtPct } from '../fmt';

export default function WatchList() {
  const { items, quotes, selected, select, folders, reloadWatch } = useStore();
  /** 待确认删除的文件夹：第一次点 ✕ 变红等第二下，防止误删 */
  const [confirmDel, setConfirmDel] = useState('');

  /** 按文件夹分组：先按后端给的文件夹顺序（含空文件夹），散落的票兜到末尾 */
  const groups = useMemo(() => {
    const map = new Map<string, WatchItem[]>();
    for (const f of folders) map.set(f.name, []);
    for (const it of items) {
      const g = it.grp || '默认';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(it);
    }
    return [...map.entries()];
  }, [items, folders]);

  const delFolder = async (name: string) => {
    if (confirmDel !== name) {
      setConfirmDel(name);
      return;
    }
    setConfirmDel('');
    const r: { error?: string } = await api.removeWatchFolder(name).catch((e) => ({
      error: String(e),
    }));
    if (!r.error) await reloadWatch();
  };

  return (
    <div className="sidebar">
      <div className="panel-title">
        <span>自选股</span>
        <span>{items.length} 只</span>
      </div>
      <div className="watch-list">
        {items.length === 0 && groups.length === 0 && <div className="empty">暂无自选</div>}
        {groups.map(([grp, list]) => (
          <div key={grp} className="watch-grp">
            <div className="watch-grp-head" onMouseLeave={() => setConfirmDel('')}>
              <span className="watch-grp-name">{grp}</span>
              <span className="watch-grp-count">{list.length}</span>
              {grp !== '默认' && (
                <button
                  className={`watch-grp-del${confirmDel === grp ? ' pending' : ''}`}
                  onClick={() => void delFolder(grp)}
                  title={
                    confirmDel === grp
                      ? '再点一次确认删除（里面的股票退回默认）'
                      : '删除该文件夹（里面的股票退回默认）'
                  }
                >
                  {confirmDel === grp ? '确认' : '✕'}
                </button>
              )}
            </div>
            {list.length === 0 && <div className="watch-grp-empty">空文件夹</div>}
            {list.map((it) => {
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
        ))}
      </div>
    </div>
  );
}
