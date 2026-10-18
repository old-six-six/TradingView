import type { Quote, WatchFolder, WatchItem } from './api';
import { sortBoardRows, type BoardLiteRow, type SideSort } from './store';

/**
 * 左侧列表的分组：板块列表只有一组（无组头），自选按文件夹分组。
 * 渲染（SideList）和键盘换股（App.move）都从这里取数，保证两边顺序永远一致。
 */
export interface SideSection {
  key: string;
  label: string;
  rows: BoardLiteRow[];
  /** 组内一只票都没有时的占位文案（自选的空文件夹用） */
  emptyText?: string;
}

/** 自选：按后端给的文件夹顺序分组（含空文件夹），组内票用报价补齐名称与涨幅 */
export function watchSections(
  items: WatchItem[],
  folders: WatchFolder[],
  quotes: Record<string, Quote>,
): SideSection[] {
  const map = new Map<string, SideSection>();
  for (const f of folders) {
    map.set(f.name, { key: f.name, label: f.name, rows: [], emptyText: '空文件夹' });
  }
  for (const it of items) {
    const g = it.grp || '默认';
    let sec = map.get(g);
    if (!sec) {
      sec = { key: g, label: g, rows: [], emptyText: '空文件夹' };
      map.set(g, sec);
    }
    const q = quotes[it.symbol] ?? it.quote;
    sec.rows.push({
      symbol: it.symbol,
      code: it.symbol.slice(2),
      name: q?.name || it.name,
      price: q?.price ?? 0,
      changePct: q?.changePct ?? 0,
    });
  }
  return [...map.values()];
}

/** 把分组按当前排序方式摊平成一串 symbol，键盘【 】就按这个顺序翻 */
export function sectionSymbols(sections: SideSection[], sort: SideSort): string[] {
  const out: string[] = [];
  for (const s of sections) {
    for (const r of sortBoardRows(s.rows, sort)) out.push(r.symbol);
  }
  return out;
}
