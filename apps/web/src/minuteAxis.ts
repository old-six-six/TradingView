/**
 * 分时图的价格轴口径，对齐同花顺：右侧每格「价格 + 相对昨收的涨跌幅」。
 *
 * 横轴不在这里——库自带的刻度在午休断点（11:30 与 13:00 只隔一根）会成对丢失，
 * 所以分时的时间轴整个关掉，由 components/MinuteAxis.tsx 自绘。
 */

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 逐分钟列出 [from, to] 闭区间，'09:30' 这种 */
function minuteRange(fromH: number, fromM: number, toH: number, toM: number): string[] {
  const out: string[] = [];
  let h = fromH;
  let m = fromM;
  for (;;) {
    out.push(`${pad2(h)}:${pad2(m)}`);
    if (h === toH && m === toM) break;
    if (++m === 60) {
      m = 0;
      h += 1;
    }
  }
  return out;
}

/**
 * 一个完整交易日的分钟坐标：9:30–11:30（121 个）+ 13:00–15:00（121 个），共 242 个。
 *
 * 分时的横轴必须按整日固定，不能跟着「已经走了几分钟」拉伸——否则早盘十点
 * 那几十个点会被铺满整屏，9:30→10:30 看起来像过了大半天。数据只铺到当前时刻，
 * 剩下的槽位留白（同花顺就是这样，右侧是空的）。
 */
export const SESSION_TIMES: readonly string[] = [
  ...minuteRange(9, 30, 11, 30),
  ...minuteRange(13, 0, 15, 0),
];

/**
 * 分时价格轴格式：价格 + 涨跌幅。
 * prevClose 为 0（缺少昨收）时退回纯价格，避免除零。
 */
export function minutePriceFormat(prevClose: number) {
  return {
    type: 'custom' as const,
    minMove: 0.01,
    formatter: (price: number): string => {
      if (!Number.isFinite(price)) return '';
      const px = price.toFixed(2);
      if (!prevClose) return px;
      const pct = (price / prevClose - 1) * 100;
      const sign = pct > 0.0001 ? '+' : '';
      return `${px}   ${sign}${pct.toFixed(2)}%`;
    },
  };
}
