import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';

/**
 * 「加入自选」弹窗：选一个已有文件夹，或就地新建一个。
 * 文件夹列表里也能删（默认文件夹除外），删掉的是壳，里面的票退回默认。
 */
export default function WatchAddModal({
  symbol,
  fallbackName,
  onClose,
}: {
  symbol: string;
  fallbackName?: string;
  onClose: () => void;
}) {
  const { folders, items, quotes, reloadWatch } = useStore();
  const current = items.find((it) => it.symbol === symbol)?.grp ?? '';
  const name = quotes[symbol]?.name || items.find((it) => it.symbol === symbol)?.name || fallbackName || symbol;

  const [picked, setPicked] = useState(() => current || folders[0]?.name || '默认');
  const [newName, setNewName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  /** 待确认删除的文件夹名：第一次点 ✕ 变成「确认」，再点才真删 */
  const [pendingDel, setPendingDel] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // folders 是异步来的，首帧可能还没有；选中的文件夹被删掉时也退回第一个
  useEffect(() => {
    if (!picked) {
      setPicked(current || folders[0]?.name || '默认');
      return;
    }
    if (folders.length && !folders.some((f) => f.name === picked)) {
      setPicked(folders[0].name);
    }
  }, [current, folders, picked]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sorted = useMemo(
    () => [...folders].sort((a, b) => (a.name === '默认' ? -1 : b.name === '默认' ? 1 : a.name.localeCompare(b.name))),
    [folders],
  );

  const createFolder = async () => {
    const raw = newName.trim();
    if (!raw || busy) return;
    setBusy(true);
    setErr('');
    const r: { error?: string; name?: string } = await api.addWatchFolder(raw).catch((e) => ({
      error: String(e),
    }));
    setBusy(false);
    if (r.error) {
      setErr(r.error);
      return;
    }
    setNewName('');
    await reloadWatch();
    if (r.name) setPicked(r.name);
  };

  const delFolder = async (folder: string) => {
    if (pendingDel !== folder) {
      setPendingDel(folder);
      return;
    }
    setBusy(true);
    setErr('');
    const r: { error?: string } = await api.removeWatchFolder(folder).catch((e) => ({
      error: String(e),
    }));
    setBusy(false);
    setPendingDel('');
    if (r.error) {
      setErr(r.error);
      return;
    }
    await reloadWatch();
    if (picked === folder) setPicked('默认');
  };

  const submit = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setErr('');
    const r: { error?: string } = await api.addWatch(symbol, name, picked).catch((e) => ({
      error: String(e),
    }));
    setBusy(false);
    if (r.error) {
      setErr(r.error);
      return;
    }
    await reloadWatch();
    onClose();
  };

  const same = current && current === picked;

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="watch-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wm-head">
          <span className="wm-title">加入自选</span>
          <span className="wm-stock">{name}</span>
          <span className="wm-code num">{symbol.slice(2)}</span>
          {current && <span className="wm-cur">当前在「{current}」</span>}
          <button className="wm-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        <div className="wm-body">
          <div className="wm-label">选择自选文件夹</div>
          <div className="wm-folders">
            {sorted.map((f) => (
              <div
                key={f.name}
                className={`wm-folder${picked === f.name ? ' active' : ''}`}
                onClick={() => {
                  setPicked(f.name);
                  setPendingDel('');
                  inputRef.current?.blur();
                }}
              >
                <span className="wm-radio" />
                <span className="wm-fname">{f.name}</span>
                <span className="wm-count">{f.count}</span>
                {f.name === current && <span className="wm-here">已在此</span>}
                {f.name !== '默认' && (
                  <button
                    className={`wm-del${pendingDel === f.name ? ' pending' : ''}`}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void delFolder(f.name);
                    }}
                    title={pendingDel === f.name ? '再点一次确认删除' : '删除该文件夹（里面的股票退回默认）'}
                  >
                    {pendingDel === f.name ? '确认删除' : '✕'}
                  </button>
                )}
              </div>
            ))}
            {!sorted.length && <div className="wm-empty">还没有文件夹</div>}
          </div>
          <div className="wm-hint">删文件夹只删壳，里面的股票会退回「默认」</div>

          <div className="wm-label">新建文件夹</div>
          <div className="wm-new">
            <input
              ref={inputRef}
              value={newName}
              maxLength={16}
              placeholder="输入名称，比如「短线」「观察池」"
              onChange={(e) => {
                setNewName(e.target.value);
                setErr('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder();
                e.stopPropagation();
              }}
            />
            <button onClick={() => void createFolder()} disabled={!newName.trim() || busy}>
              新建
            </button>
          </div>

          {err && <div className="wm-err">{err}</div>}
        </div>

        <div className="wm-foot">
          <button className="wm-btn" onClick={onClose}>
            取消
          </button>
          <button className="wm-btn primary" onClick={() => void submit()} disabled={!picked || busy || !!same}>
            {busy ? '处理中…' : same ? `已在「${picked}」` : current ? '移动到此' : '加入'}
          </button>
        </div>
      </div>
    </div>
  );
}
