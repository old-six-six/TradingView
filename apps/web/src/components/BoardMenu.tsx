import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { MARKET_TABS } from './MarketPage';

/**
 * 「沪深京」下拉：把当前位置切到五大板块之一。
 * 板块和自选文件夹在 store 里是同一类「位置」（entry），所以切过去之后
 * 左侧列表、排序、首尾跳转、键盘【 】的行为与自选完全一致。
 */
export default function BoardMenu({ onClose }: { onClose: () => void }) {
  const { entry } = useStore();
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

  const choose = (key: string) => {
    const st = useStore.getState();
    st.setEntry(key);
    // 换板块时先清掉旧名单，别让左侧拿上一个板块的股票顶一下；
    // 新名单由 App 的轮询 effect 拉，到位后当前票不在其中会自动落到第一只
    if (st.boardRows && st.boardRows.board !== key) st.setBoardRows(null);
    // 左侧收起来了就先展开，否则「切了位置却什么都没变」
    if (!st.sidebar) st.toggleSidebar();
    onClose();
  };

  return (
    <div className="pos-menu board-menu" ref={boxRef}>
      <div className="pos-menu-title">沪深京</div>
      {MARKET_TABS.map((t) => (
        <button
          key={t.key}
          className={`pos-item${entry === t.key ? ' active' : ''}`}
          onClick={() => choose(t.key)}
          title={`左侧列出${t.label}全部股票`}
        >
          <span className="pos-item-name">{t.label}</span>
        </button>
      ))}
    </div>
  );
}
