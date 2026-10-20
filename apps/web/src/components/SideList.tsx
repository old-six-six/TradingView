import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { sortBoardRows, useStore, type BoardLiteRow } from '../store';
import type { SideSection } from '../sideOrder';
import { cls, fmtNum, fmtPct } from '../fmt';

/** 行高固定，虚拟滚动靠它算位置 */
export const SIDE_ROW_H = 44;
/** 文件夹组头高度 */
const SIDE_HEAD_H = 26;
/** 空文件夹占位行 */
const SIDE_EMPTY_H = 24;
/** 视野外多渲染几行，快速滚动时不至于闪白 */
const BUFFER = 6;

export interface SideAction {
  /** 常态文案，如 ✕ */
  label: string;
  /** 待确认文案，如 确认 */
  pendingLabel: string;
  title: string;
  pending: boolean;
  onClick: () => void;
  /** 鼠标移出组头时复位两段式确认 */
  onLeave?: () => void;
}

type Item =
  | { kind: 'head'; section: SideSection; h: number }
  | { kind: 'empty'; key: string; text: string; h: number }
  | { kind: 'row'; row: BoardLiteRow; h: number };

/**
 * 左侧列表的通用实现：板块成员和自选股都用它渲染。
 * 标题栏统一带「跳到首/尾 + 排序方式」，行高、跟随选中、键盘顺序也同一套。
 * headless（只有一个分组）时不画组头，就是板块列表原来的样子。
 */
export default function SideList({
  title,
  sections,
  selected,
  onPick,
  actions,
  onRemove,
  emptyText,
  loading,
  headless,
}: {
  title: ReactNode;
  sections: SideSection[];
  selected: string;
  onPick: (symbol: string) => void;
  /** 组头右侧的删除按钮，按分组 key 给 */
  actions?: Record<string, SideAction>;
  /** 每行右侧的「从自选移除」，只有自选列表传（板块成员不能删） */
  onRemove?: (symbol: string) => void;
  emptyText?: string;
  loading?: boolean;
  headless?: boolean;
}) {
  const { sideSort, setSideSort } = useStore();
  const boxRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(560);
  /** 待确认删除的票：第一次点 ✕ 变「确认」，再点才真删 */
  const [pendingDel, setPendingDel] = useState('');
  /** 选中的票、排序方式变了就把列表滚过去，避免换完股看不到自己翻到哪 */
  const followRef = useRef('');

  const flat = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const s of sections) {
      if (!headless) out.push({ kind: 'head', section: s, h: SIDE_HEAD_H });
      const rows = sortBoardRows(s.rows, sideSort);
      if (!rows.length && s.emptyText) {
        out.push({ kind: 'empty', key: s.key, text: s.emptyText, h: SIDE_EMPTY_H });
      }
      for (const row of rows) out.push({ kind: 'row', row, h: SIDE_ROW_H });
    }
    return out;
  }, [sections, sideSort, headless]);

  /** 每一项的纵向起点，虚拟滚动和跟随都靠它 */
  const tops = useMemo(() => {
    let y = 0;
    return flat.map((it) => {
      const t = y;
      y += it.h;
      return t;
    });
  }, [flat]);
  const total = useMemo(() => flat.reduce((n, it) => n + it.h, 0), [flat]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const followKey = `${sideSort}|${selected}|${flat.length}`;
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !flat.length) return;
    if (followRef.current === followKey) return;
    const i = flat.findIndex((it) => it.kind === 'row' && it.row.symbol === selected);
    if (i < 0) return;
    followRef.current = followKey;
    // 只在看不见的时候滚，别把用户手动翻的位置抢走
    if (tops[i] < el.scrollTop || tops[i] + SIDE_ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, tops[i] - el.clientHeight / 2 + SIDE_ROW_H / 2);
    }
  }, [flat, tops, selected, followKey]);

  /**
   * 跳到当前排序下的第一只 / 最后一只，并把列表贴到顶或底。
   * 已经在那一端时也要能滚回去，所以除了 onPick 还直接改 scrollTop。
   */
  const jumpEdge = (to: 'top' | 'bottom') => {
    const idx =
      to === 'top'
        ? flat.findIndex((it) => it.kind === 'row')
        : flat.map((it) => it.kind).lastIndexOf('row');
    if (idx < 0) return;
    const it = flat[idx];
    if (it.kind !== 'row') return;
    // 记下新的跟随键，免得下面的居中逻辑把刚贴好的位置又挪走
    followRef.current = `${sideSort}|${it.row.symbol}|${flat.length}`;
    const el = boxRef.current;
    if (el) {
      el.scrollTop = to === 'top' ? 0 : el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
    if (it.row.symbol !== selected) onPick(it.row.symbol);
  };

  // 二分找出第一项可见的，避免每次滚动都线性扫一遍
  const start = useMemo(() => {
    const limit = scrollTop - BUFFER * SIDE_ROW_H;
    let lo = 0;
    let hi = flat.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] + flat[mid].h >= limit) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }, [scrollTop, flat, tops]);
  const end = useMemo(() => {
    const limit = scrollTop + viewH + BUFFER * SIDE_ROW_H;
    let i = start;
    while (i < flat.length && tops[i] <= limit) i += 1;
    return i;
  }, [start, scrollTop, viewH, flat, tops]);

  return (
    <div className="sidebar">
      <div className="panel-title">
        <span className="side-title">{title}</span>
        <div className="side-ctl">
          <button
            className="side-jump"
            onClick={() => jumpEdge('top')}
            title="跳到最上方（当前排序的第一只）"
            aria-label="跳到最上方"
          >
            ↑
          </button>
          <button
            className="side-jump"
            onClick={() => jumpEdge('bottom')}
            title="跳到最下方（当前排序的最后一只）"
            aria-label="跳到最下方"
          >
            ↓
          </button>
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
      </div>
      <div
        className="watch-list"
        ref={boxRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {!flat.length && <div className="empty">{loading ? '正在载入…' : emptyText || '暂无数据'}</div>}
        <div className="side-body" style={{ height: total }}>
          {flat.slice(start, end).map((it, i) => {
            const top = tops[start + i];
            if (it.kind === 'head') {
              const act = actions?.[it.section.key];
              return (
                <div
                  key={`h:${it.section.key}`}
                  className="side-grp"
                  style={{ top, height: it.h }}
                  onMouseLeave={() => act?.onLeave?.()}
                >
                  <span className="watch-grp-name">{it.section.label}</span>
                  <span className="watch-grp-count">{it.section.rows.length}</span>
                  {act && (
                    <button
                      className={`watch-grp-del${act.pending ? ' pending' : ''}`}
                      onClick={act.onClick}
                      title={act.title}
                    >
                      {act.pending ? act.pendingLabel : act.label}
                    </button>
                  )}
                </div>
              );
            }
            if (it.kind === 'empty') {
              return (
                <div key={`e:${it.key}`} className="side-empty" style={{ top, height: it.h }}>
                  {it.text}
                </div>
              );
            }
            const r = it.row;
            const pending = !!onRemove && pendingDel === r.symbol;
            return (
              <div
                key={r.symbol}
                className={`watch-item side-item${selected === r.symbol ? ' active' : ''}${onRemove ? ' has-del' : ''}`}
                style={{ top, height: it.h }}
                title={`${r.name} ${r.code}`}
                onClick={() => onPick(r.symbol)}
                onMouseLeave={() => {
                  if (pending) setPendingDel('');
                }}
              >
                <div className="side-item-main">
                  <div className="watch-row">
                    <span className="watch-name">{r.name}</span>
                    <span className={`num ${cls(r.changePct)}`}>{r.price > 0 ? fmtNum(r.price) : '--'}</span>
                  </div>
                  <div className="watch-sub">
                    <span className="num">{r.code}</span>
                    <span className={`num ${cls(r.changePct)}`}>{fmtPct(r.changePct)}</span>
                  </div>
                </div>
                {onRemove && (
                  <button
                    className={`side-del${pending ? ' pending' : ''}`}
                    title={pending ? '再点一次确认从自选移除' : '从自选移除'}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!pending) {
                        setPendingDel(r.symbol);
                        return;
                      }
                      setPendingDel('');
                      onRemove(r.symbol);
                    }}
                  >
                    {pending ? '确认' : '✕'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
