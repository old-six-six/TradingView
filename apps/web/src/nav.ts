import { useStore, type IndexRef } from './store';

/**
 * 视图切换都走这里，避免各处手写 URL 参数导致返回后状态不一致。
 * 地址栏用 ?board= 表示列表页、?symbol= 表示个股图表。
 */

/** 切到某个市场的全量列表页 */
export function gotoMarket(key: string) {
  useStore.getState().setMarket(key);
  const url = new URL(location.href);
  url.searchParams.set('board', key);
  history.replaceState(null, '', url);
}

/**
 * 从指数弹窗点「成分股」进列表页：记住这个弹窗，
 * 之后在列表页按 Esc 就把它原样弹回来（而不是直接掉回图表）。
 */
export function gotoMarketFromIndex(ref: IndexRef) {
  const st = useStore.getState();
  st.setIndexReturn(ref);
  st.setIndexModal(null);
  gotoMarket(ref.market);
}

/** 从列表页返回图表，保留之前看的那只票 */
export function backToChart() {
  useStore.getState().setMarket(null);
  const url = new URL(location.href);
  url.searchParams.delete('board');
  history.replaceState(null, '', url);
}

/** 列表页的「返回」：从指数弹窗进来的先还原弹窗，再回图表 */
export function backFromMarket() {
  const st = useStore.getState();
  const ref = st.indexReturn;
  st.setIndexReturn(null);
  backToChart();
  if (ref) st.setIndexModal(ref);
}

/**
 * 打开某只票的 K 线，同时退出列表页。
 * fromBoard 记下是从哪个市场列表点进来的，图表底部要显示「当前位置」；
 * 也会写进地址栏，刷新来源不丢。
 */
export function gotoChart(symbol: string, fromBoard?: string) {
  const st = useStore.getState();
  st.select(symbol, fromBoard ?? null);
  st.setMarket(null);
  // 去看个股了，就别再把「返回指数弹窗」挂着
  st.setIndexReturn(null);
  const url = new URL(location.href);
  url.searchParams.delete('board');
  url.searchParams.set('symbol', symbol);
  if (fromBoard) url.searchParams.set('from', fromBoard);
  else url.searchParams.delete('from');
  history.replaceState(null, '', url);
}
