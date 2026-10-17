/**
 * 搜索框的「外部唤起」通道。
 *
 * 自选列表、图表、列表页里随手敲字母/数字时要把焦点送到顶栏搜索框，
 * 但那些地方离 TopBar 很远，逐层传 ref 太啰嗦，用一个最小订阅桥即可：
 * TopBar 挂载时注册自己的入口，其它地方只管调用 focusSearch()。
 */

type FocusFn = (seed: string) => void;

let impl: FocusFn | null = null;

/** 由 TopBar 注册；返回注销函数 */
export function registerSearchFocus(fn: FocusFn): () => void {
  impl = fn;
  return () => {
    if (impl === fn) impl = null;
  };
}

/** 把焦点送到搜索框，seed 作为首字符（没有则只聚焦） */
export function focusSearch(seed = ''): boolean {
  if (!impl) return false;
  impl(seed);
  return true;
}
