import type { Bar } from './api';

/**
 * 大智慧「支撑压力」指标（主图）移植。
 *
 * 原码：
 *   Var1:=IF(DATE>=10201201,0,1);
 *   Var2:=EMA(SLOPE(CLOSE,21)*20+CLOSE,55);
 *   Var3:=EMA(CLOSE,3);
 *   Var4:=(2*CLOSE+LOW+HIGH)/4*Var1;
 *   风险线:EMA(Var4,45)*1.15;
 *   必卖线:EMA(Var4,55)*1.3;
 *   底线:EMA(Var4,40)*0.85;
 *   铁底线:EMA(Var4,88)*0.7;
 *   成本线:EMA(Var4,55);
 *   持仓:STICKLINE(Var5>=0,Var3,Var2,0.5,0);
 *   减仓:STICKLINE(Var5<0,Var3,Var2,0.5,0);
 *   价值中枢:(成本线+底线)/2;
 *   其中 Var5 = Var2 - Var3。
 *
 * 关于 Var1：大智慧的 DATE 用「年份 - 1900」的 YYMMDD，10201201 即 2002-12-01，
 * 按原文写成 DATE>=10201201 就变成「2002 年之后 Var1 = 0」，于是 Var4 恒为 0、
 * 六条线全部贴在 0 轴上 —— 原公式直接搬到今天的行情里其实是一张空图。
 * 按作者本意（老数据才需要修正权重）这里取 Var1 = 1，即 Var4 = (2C+L+H)/4。
 * 若以后要复刻那个开关，把 USE_DATE_GATE 打开即可。
 */

/** 大智慧那个历史遗留的日期开关，默认关掉（见文件头说明） */
const USE_DATE_GATE = false;
/** 10201201 = 2002-12-01（年份 - 1900 的写法） */
const GATE_TS = Date.UTC(2002, 11, 1) / 1000;

const NaN_ = Number.NaN;

/** 指数移动平均：首值作种子，遇到无效值跳过但不重置 */
export function ema(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN_);
  const k = 2 / (n + 1);
  let prev = NaN_;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    prev = Number.isFinite(prev) ? v * k + prev * (1 - k) : v;
    out[i] = prev;
  }
  return out;
}

/**
 * 线性回归斜率 SLOPE(X,N)：最近 N 根做最小二乘，x 取 0..N-1。
 * 用前缀和把 O(n·N) 降到 O(n)，几千根也不卡。
 */
export function slope(values: number[], n: number): number[] {
  const len = values.length;
  const out = new Array<number>(len).fill(NaN_);
  if (n < 2 || len < n) return out;

  const sx = (n * (n - 1)) / 2;
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
  const den = n * sxx - sx * sx;
  if (!den) return out;

  const ps = new Array<number>(len + 1).fill(0);
  const pxy = new Array<number>(len + 1).fill(0);
  for (let i = 0; i < len; i++) {
    const v = Number.isFinite(values[i]) ? values[i] : 0;
    ps[i + 1] = ps[i] + v;
    pxy[i + 1] = pxy[i] + i * v;
  }

  for (let i = n - 1; i < len; i++) {
    const start = i - n + 1;
    const sy = ps[i + 1] - ps[start];
    // Σ(x·y) 里 x 要相对窗口起点，先按绝对下标求和再减掉 start·Σy
    const sxy = pxy[i + 1] - pxy[start] - start * sy;
    out[i] = (n * sxy - sx * sy) / den;
  }
  return out;
}

export interface SupportPressure {
  /** 风险线 EMA(T,45)×1.15 */
  risk: number[];
  /** 必卖线 EMA(T,55)×1.3 */
  sell: number[];
  /** 底线 EMA(T,40)×0.85 */
  floor: number[];
  /** 铁底线 EMA(T,88)×0.7 */
  iron: number[];
  /** 成本线 EMA(T,55) */
  cost: number[];
  /** 价值中枢 (成本线 + 底线) / 2 */
  mid: number[];
  /** Var2：EMA(SLOPE(C,21)×20+C, 55)，竖柱上端 */
  slow: number[];
  /** Var3：EMA(C,3)，竖柱下端 */
  fast: number[];
  /** Var5 = slow - fast，≥0 持仓（柱向上），<0 减仓 */
  diff: number[];
}

/** 全部数组与 bars 等长，前段不足窗口的位置是 NaN，画的时候跳过 */
export function calcSupportPressure(bars: Bar[]): SupportPressure {
  const closes = bars.map((b) => b.close);
  const tv = bars.map((b) => {
    const base = (2 * b.close + b.low + b.high) / 4;
    if (!USE_DATE_GATE) return base;
    const gate = Date.UTC(
      Number(b.date.slice(0, 4)),
      Number(b.date.slice(5, 7)) - 1,
      Number(b.date.slice(8, 10)),
    ) / 1000;
    return gate >= GATE_TS ? base : 0;
  });

  const sl = slope(closes, 21);
  // SLOPE×20 + CLOSE：把 21 根的斜率放大成 20 根的位移，相当于给均线加个前视推力
  const proj = closes.map((c, i) => (Number.isFinite(sl[i]) ? sl[i] * 20 + c : NaN_));

  const slow = ema(proj, 55);
  const fast = ema(closes, 3);
  const diff = slow.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(fast[i]) ? v - fast[i] : NaN_,
  );

  const cost = ema(tv, 55);
  const risk = ema(tv, 45).map((v) => v * 1.15);
  // 必卖线就是成本线 ×1.3，不必再算一遍 EMA
  const sell = cost.map((v) => v * 1.3);
  const floor = ema(tv, 40).map((v) => v * 0.85);
  const iron = ema(tv, 88).map((v) => v * 0.7);
  const mid = cost.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(floor[i]) ? (v + floor[i]) / 2 : NaN_,
  );

  return { risk, sell, floor, iron, cost, mid, slow, fast, diff };
}
