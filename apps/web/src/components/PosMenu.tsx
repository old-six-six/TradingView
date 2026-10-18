import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { sortBoardRows, useStore } from '../store';
import {
  watchEntryKey,
  watchEntryFolder,
  watchFolderRows,
  isWatchEntry,
} from '../sideOrder';

/**
 * 「自选板块」下拉：把当前位置切到某个自选文件夹，或就地新建一个。
 * 选中后左侧列表、键盘【 】、当前位置名称都按该文件夹走，和五大板块完全一致。
 */
export default function PosMenu({ onClose }: { onClose: () => void }) {
  const { folders, items, entry } = useStore();
  const [newName, setNewName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      // 点按钮本身交给它的 onClick 去开/关，这里别抢
      if (t.closest('.pos-wrap')) return;
      if (boxRef.current && !boxRef.current.contains(t as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 捕获阶段监听，避免被图表自己的 mousedown 处理吞掉
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  /** 切到某个位置：自选文件夹用 w: 前缀；null = 回到全部自选 */
  const choose = (folder: string | null) => {
    const st = useStore.getState();
    if (!folder) {
      st.setEntry(null);
      onClose();
      return;
    }
    const key = watchEntryKey(folder);
    st.setEntry(key);
    // 当前这只票不在该文件夹里时，自动落到文件夹的第一只（按当前排序）
    const rows = watchFolderRows(st.items, st.folders, st.quotes, folder);
    const first = sortBoardRows(rows, st.sideSort)[0];
    if (first && !rows.some((r) => r.symbol === st.selected)) st.select(first.symbol, key);
    // 左侧收起来了就先展开，否则「切了位置却什么都没变」
    if (!st.sidebar) st.toggleSidebar();
    onClose();
  };

  const create = async () => {
    const raw = newName.trim();
    if (!raw || busy) return;
    setBusy(true);
    setErr('');
    const r: { error?: string; name?: string } = await api
      .addWatchFolder(raw)
      .catch((e) => ({ error: String(e) }));
    setBusy(false);
    if (r.error) {
      setErr(r.error);
      return;
    }
    await useStore.getState().reloadWatch();
    choose(r.name ?? raw);
  };

  const activeFolder = isWatchEntry(entry) ? watchEntryFolder(entry) : null;

  return (
    <div className="pos-menu" ref={boxRef}>
      <div className="pos-menu-title">自选板块</div>
      <button
        className={`pos-item${!entry ? ' active' : ''}`}
        onClick={() => choose(null)}
        title="不限定板块，左侧列出全部自选"
      >
        <span className="pos-item-name">全部自选</span>
        <span className="pos-item-count">{items.length}</span>
      </button>
      {folders.map((f) => (
        <button
          key={f.name}
          className={`pos-item${activeFolder === f.name ? ' active' : ''}`}
          onClick={() => choose(f.name)}
          title={`自选文件夹：${f.name}`}
        >
          <span className="pos-item-name">{f.name}</span>
          <span className="pos-item-count">{f.count ?? 0}</span>
        </button>
      ))}
      <div className="pos-new">
        <input
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            setErr('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
          placeholder="新建自选文件夹"
          maxLength={16}
        />
        <button onClick={() => void create()} disabled={busy || !newName.trim()}>
          新建
        </button>
      </div>
      {err && <div className="pos-err">{err}</div>}
    </div>
  );
}
