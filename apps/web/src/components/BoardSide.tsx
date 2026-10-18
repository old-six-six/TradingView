import { useEffect, useMemo, useRef, useState } from 'react';
import { sortBoardRows, useStore } from '../store';
import { cls, fmtNum, fmtPct } from '../fmt';

const ROW_H = 44;
/** 视野外多渲染几行，快速滚动时不至于闪白 */
const BUFFER = 6;

/**
 * 左侧板块列表：内容是「当前位置」那个板块的全部股票。
 * 排序方式可切（代码 / 涨幅），键盘 【 】 也跟着这个顺序走。
 */
export default function BoardSide({ label }: { label: string }) {
  const { boardRows, sideSort, setSideSort, selected, select, entry } = useStore();
  const boxRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(560);
  /** 选中的票、排序方式变了就把列表滚过去，避免换完股看不到自己翻到哪 */
  const followRef = useRef('');

  const rows = boardRows?.board === entry ? boardRows.rows : [];
  const sorted = useMemo(() => sortBoardRows(rows, sideSort), [rows, sideSort]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const followKey = `${sideSort}|${selected}`;
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !sorted.length) return;
    if (followRef.current === followKey) return;
    const i = sorted.findIndex((r) => r.symbol === selected);
    if (i < 0) return;
    followRef.current = followKey;
    const top = i * ROW_H;
    // 只在看不见的时候滚，别把用户手动翻的位置抢走
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ROW_H / 2);
    }
  }, [sorted, selected, followKey]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
  const end = Math.min(sorted.length, Math.ceil((scrollTop + viewH) / ROW_H) + BUFFER);
  const slice = sorted.slice(start, end);

  return (
    <div className="sidebar">
      <div className="panel-title">
        <span>{label}</span>
        <select
          className="side-select"
          value={sideSort}
          onChange={(e) => setSideSort(e.target.value as 'code' | 'pct')}
          title="左侧列表的排序方式，键盘【 】也按这个顺序走"
        >
          <option value="code">代码</option>
          <option value="pct">涨幅</option>
        </select>
      </div>
      <div className="watch-list" ref={boxRef} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
        {!rows.length && <div className="empty">正在载入{label}…</div>}
        <div style={{ height: start * ROW_H }} />
        {slice.map((r) => (
          <div
            key={r.symbol}
            className={`watch-item side-item${selected === r.symbol ? ' active' : ''}`}
            style={{ height: ROW_H }}
            title={`${r.name} ${r.code}`}
            onClick={() => select(r.symbol, entry)}
          >
            <div className="watch-row">
              <span className="watch-name">{r.name}</span>
              <span className={`num ${cls(r.changePct)}`}>{r.price > 0 ? fmtNum(r.price) : '--'}</span>
            </div>
            <div className="watch-sub">
              <span className="num">{r.code}</span>
              <span className={`num ${cls(r.changePct)}`}>{fmtPct(r.changePct)}</span>
            </div>
          </div>
        ))}
        <div style={{ height: Math.max(0, (sorted.length - end) * ROW_H) }} />
      </div>
    </div>
  );
}
