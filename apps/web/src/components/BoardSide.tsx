import { useMemo } from 'react';
import { useStore } from '../store';
import type { SideSection } from '../sideOrder';
import SideList from './SideList';

/**
 * 左侧板块列表：内容是「当前位置」那个板块的全部股票。
 * 排序方式可切（代码 / 涨幅），键盘 【 】 也跟着这个顺序走。
 */
export default function BoardSide({ label }: { label: string }) {
  const { boardRows, entry, selected, select } = useStore();

  const rows = boardRows?.board === entry ? boardRows.rows : [];
  const sections = useMemo<SideSection[]>(
    () => [{ key: entry ?? 'board', label, rows }],
    [entry, label, rows],
  );

  return (
    <SideList
      headless
      title={label}
      sections={sections}
      selected={selected}
      onPick={(symbol) => select(symbol, entry)}
      loading={!rows.length}
      emptyText="这个板块暂时没有成员"
    />
  );
}
