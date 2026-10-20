import { useMemo } from 'react';
import { useStore } from '../store';
import {
  isWatchEntry,
  watchEntryFolder,
  watchFolderRows,
  type SideSection,
} from '../sideOrder';
import { MARKET_POS_LABEL } from './MarketPage';
import { useRemoveWatch } from '../watchOps';
import SideList from './SideList';

/**
 * 左侧「当前位置」列表。五大板块和自选文件夹是同一种东西：
 * 一个位置 → 一串成员，排序、首尾跳转、键盘顺序完全共用。
 */
export default function BoardSide() {
  const { boardRows, entry, items, folders, quotes, selected, select } = useStore();
  const removeWatch = useRemoveWatch();

  const folder = watchEntryFolder(entry);
  const label = folder ?? (entry ? MARKET_POS_LABEL[entry] ?? entry : '板块');

  const sections = useMemo<SideSection[]>(() => {
    if (folder !== null) {
      return [{ key: entry ?? folder, label: folder, rows: watchFolderRows(items, folders, quotes, folder) }];
    }
    const rows = boardRows?.board === entry ? boardRows.rows : [];
    return [{ key: entry ?? 'board', label, rows }];
  }, [folder, entry, label, items, folders, quotes, boardRows]);

  const rows = sections[0].rows;

  return (
    <SideList
      headless
      title={label}
      sections={sections}
      selected={selected}
      onPick={(symbol) => select(symbol, entry)}
      // 「当前位置」是自选文件夹时也能删票，五大板块的成员不能删
      onRemove={folder !== null ? (symbol) => void removeWatch(symbol) : undefined}
      // 自选文件夹空着是正常状态，不要显示「正在载入」
      loading={!isWatchEntry(entry) && !rows.length}
      emptyText={folder !== null ? '该文件夹里还没有股票' : '这个板块暂时没有成员'}
    />
  );
}
