import type { Bar } from './api';
import { ema } from './supportPressure';

/**
 * 大智慧「财运亨通」指标（副图）移植。
 *
 * 原码：
 *   VAR1:=(2*CLOSE+HIGH+LOW+OPEN)/5;
 *   逃顶: 80;
 *   VAR2:=LLV(LOW,34);
 *   VAR3:=HHV(HIGH,34);
 *   SK: EMA((VAR1-VAR2)/(VAR3-VAR2)*100,13);
 *   SD: EMA(SK,3);
 *   FILLRGN(sd,80,sd>80),ColorFFFF00;
 *   FILLRGN(sd,20,sd<20),COLOR00AAFF;
 *   吸货: 20;
 *   楚河分界: 50;
 *   VAR4:=IF(CROSS(SK,SD),40,22);
 *   VAR5:=IF(CROSS(SD,SK),60,78);
 *   卖出: VAR5;
 *   买进: VAR4;
 *
 * 本质是 34 根区间的随机指标（算法同 KDJ 的 %K），再叠 80/50/20 三条水平线：
 *   - 80 以上「逃顶」区涂黄，20 以下「吸货」区涂蓝；
 *   - 买进线常态 22，金叉那根跳到 40；
 *   - 卖出线常态 78，死叉那根掉到 60。
 * 后两条在原码里是普通输出线（冒号，不是 STICKLINE），所以画出来是两条
 * 常态水平的阶梯线，只在交叉那根冒一下尖 —— 这里照原样还原。
 */

/** LLV/HHV 的窗口：34 根 */
const LOOKBACK = 34;
/** SK 的 EMA 平滑周期 */
const SK_N = 13;
/** SD 的 EMA 平滑周期 */
const SD_N = 3;

/** 逃顶 / 吸货 / 楚河分界三条水平线 */
export const FORTUNE_TOP = 80;
export const FORTUNE_BOTTOM = 20;
export const FORTUNE_MID = 50;
/** 金叉/死叉时买进、卖出线的跳变值 */
const BUY_HIT = 40;
const BUY_IDLE = 22;
const SELL_HIT = 60;
const SELL_IDLE = 78;

export interface Fortune {
  /** SK: EMA(区间随机值, 13) */
  sk: number[];
  /** SD: EMA(SK, 3) */
  sd: number[];
  /** 买进线：金叉那根 40，其余 22 */
  buy: number[];
  /** 卖出线：死叉那根 60，其余 78 */
  sell: number[];
  /** 金叉（SK 上穿 SD），供图例提示 */
  golden: boolean[];
  /** 死叉（SD 上穿 SK） */
  dead: boolean[];
}

/** 滚动最大/最小；窗口 34 直接朴素扫，七千根也就几毫秒 */
function rolling(values: number[], n: number, kind: 'max' | 'min'): number[] {
  const len = values.length;
  const out = new Array<number>(len).fill(Number.NaN);
  if (n < 1 || len < n) return out;
  for (let i = n - 1; i < len; i++) {
    let m = kind === 'max' ? -Infinity : Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      const v = values[j];
      if (!Number.isFinite(v)) continue;
      m = kind === 'max' ? Math.max(m, v) : Math.min(m, v);
    }
    out[i] = Number.isFinite(m) ? m : Number.NaN;
  }
  return out;
}

/** 全部数组与 bars 等长，前 33 根不足一个窗口，是 NaN，画的时候跳过 */
export function calcFortune(bars: Bar[]): Fortune {
  const n = bars.length;
  // VAR1 的加权价：(2C + H + L + O) / 5
  const price = bars.map((b) => (2 * b.close + b.high + b.low + b.open) / 5);
  const var2 = rolling(
    bars.map((b) => b.low),
    LOOKBACK,
    'min',
  );
  const var3 = rolling(
    bars.map((b) => b.high),
    LOOKBACK,
    'max',
  );

  const raw = new Array<number>(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    const lo = var2[i];
    const hi = var3[i];
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    const span = hi - lo;
    // 34 根内高低完全相同（长期停牌、一字板）时大智慧会除零，
    // 这里给中性的 50，免得整条曲线从中间断掉
    raw[i] = span > 0 ? ((price[i] - lo) / span) * 100 : 50;
  }

  const sk = ema(raw, SK_N);
  const sd = ema(sk, SD_N);

  const buy = new Array<number>(n).fill(Number.NaN);
  const sell = new Array<number>(n).fill(Number.NaN);
  const golden = new Array<boolean>(n).fill(false);
  const dead = new Array<boolean>(n).fill(false);

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(sk[i]) || !Number.isFinite(sd[i])) continue;
    const prevOk = i > 0 && Number.isFinite(sk[i - 1]) && Number.isFinite(sd[i - 1]);
    // CROSS(A,B)：前一根 A<=B，本根 A>B
    const g = prevOk && sk[i - 1] <= sd[i - 1] && sk[i] > sd[i];
    const d = prevOk && sd[i - 1] <= sk[i - 1] && sd[i] > sk[i];
    golden[i] = g;
    dead[i] = d;
    buy[i] = g ? BUY_HIT : BUY_IDLE;
    sell[i] = d ? SELL_HIT : SELL_IDLE;
  }

  return { sk, sd, buy, sell, golden, dead };
}
