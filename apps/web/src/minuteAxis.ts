/**
 * 分时图的价格轴口径，对齐同花顺：右侧每格「价格 + 相对昨收的涨跌幅」。
 *
 * 横轴不在这里——库自带的刻度在午休断点（11:30 与 13:00 只隔一根）会成对丢失，
 * 所以分时的时间轴整个关掉，由 components/MinuteAxis.tsx 自绘。
 */

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
