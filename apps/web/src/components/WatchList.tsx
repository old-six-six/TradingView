import { useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { watchSections } from '../sideOrder';
import { useRemoveWatch } from '../watchOps';
import SideList, { type SideAction } from './SideList';

/**
 * 左侧自选：显示逻辑与五大板块列表一致——同样的行高、排序下拉、
 * 首尾跳转、跟随选中；区别只是按文件夹分组，组头带「名称 + 票数 + 删除」。
 */
export default function WatchList() {
  const { items, quotes, folders, selected, select, reloadWatch, toggleCollapse } = useStore();
  const removeWatch = useRemoveWatch();
  /** 待确认删除的文件夹：第一次点 ✕ 变红等第二下，防止误删 */
  const [confirmDel, setConfirmDel] = useState('');

  const sections = useMemo(() => watchSections(items, folders, quotes), [items, folders, quotes]);

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

  const actions = useMemo<Record<string, SideAction>>(() => {
    const out: Record<string, SideAction> = {};
    for (const f of folders) {
      // 「默认」是兜底分组，删了票就没地方去了
      if (f.name === '默认') continue;
      const pending = confirmDel === f.name;
      out[f.name] = {
        label: '✕',
        pendingLabel: '确认',
        pending,
        title: pending ? '再点一次确认删除（里面的股票退回默认）' : '删除该文件夹（里面的股票退回默认）',
        onClick: () => void delFolder(f.name),
        onLeave: () => setConfirmDel((v) => (v === f.name ? '' : v)),
      };
    }
    return out;
  }, [folders, confirmDel]);

  return (
    <SideList
      title={
        <>
          自选股<span className="side-count">{items.length}</span>
        </>
      }
      sections={sections}
      selected={selected}
      onPick={(symbol) => select(symbol)}
      onRemove={(symbol) => void removeWatch(symbol)}
      // 全部自选这一层才分组，才谈得上折叠；单看一个文件夹时（BoardSide）不传
      onToggleCollapse={toggleCollapse}
      actions={actions}
      emptyText="暂无自选"
    />
  );
}
