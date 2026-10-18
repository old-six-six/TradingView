/**
 * 主图与指数弹窗共用的周期定义。
 *
 * 这两处的周期表本来各写了一份，改周期时容易只改一边；统一放这里。
 */

export interface PeriodDef {
  key: string;
  label: string;
}

export const PERIODS: PeriodDef[] = [
  { key: 'minute', label: '分时' },
  { key: 'm5', label: '5分' },
  { key: 'm15', label: '15分' },
  { key: 'm30', label: '30分' },
  { key: 'm60', label: '60分' },
  { key: 'day', label: '日K' },
  { key: 'week', label: '周K' },
  { key: 'month', label: '月K' },
];

/** 分钟级周期（含分时）：时间轴要显示时分，日线以上只显示日期。month 不能按 m+数字 论 */
export function isIntraday(period: string): boolean {
  return period === 'minute' || /^m\d+$/.test(period);
}

/** 各周期一屏默认显示的 K 线根数，取同花顺的观感 */
export const BARS_ON_SCREEN: Record<string, number> = {
  m5: 240,
  m15: 176,
  m30: 128,
  m60: 96,
  day: 150,
  week: 140,
  month: 120,
};
