import { useCallback } from 'react';
import { api } from './api';
import { useStore } from './store';
import { sectionSymbols, watchEntryFolder, watchSections } from './sideOrder';

/**
 * 从自选里删一只票。
 *
 * 删的正好是当前看的那只时，落到同一排序下的「下一只」（到头了取上一只），
 * 比直接退回列表第一只温和得多；一只都不剩才交给 reloadWatch 去兜底。
 * 「当前位置」是自选文件夹时只在文件夹内部顺位，别跳到别的文件夹去。
 * 左侧列表的行内 ✕ 和「加入自选」弹窗里的「从自选移除」共用这一套。
 */
export function useRemoveWatch(): (symbol: string) => Promise<void> {
  const { items, folders, quotes, selected, sideSort, entry, reloadWatch, select } = useStore();

  return useCallback(
    async (symbol: string) => {
      const folder = watchEntryFolder(entry);
      const all = watchSections(items, folders, quotes);
      const order = sectionSymbols(folder ? all.filter((s) => s.key === folder) : all, sideSort);
      const at = order.indexOf(symbol);
      const next = at >= 0 ? (order[at + 1] ?? order[at - 1] ?? null) : null;

      await api.removeWatch(symbol).catch(() => undefined);
      await reloadWatch();
      // reloadWatch 会把选中票换成第一只，这里再改回「原来那只的邻居」，
      // 并且带着原来的「当前位置」，否则自选文件夹这个位置会被清掉
      if (symbol === selected && next) select(next, folder ? entry : null);

      // 文件夹被删空了就别再停在它上面，否则左边空着、右边是别的文件夹的票
      const st = useStore.getState();
      if (folder && !st.items.some((it) => (it.grp || '默认') === folder)) st.setEntry(null);
    },
    [items, folders, quotes, selected, sideSort, entry, reloadWatch, select],
  );
}
