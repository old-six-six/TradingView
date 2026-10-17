import type { Bar, IndicatorSeries } from '../types.js';

const NaN_ = Number.NaN;

/** 简单移动平均，前置不足 n 的位置为 NaN */
export function sma(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN_);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 指数移动平均，首值作为种子 */
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

/** 标准差（总体），用于 BOLL */
function stddev(values: number[], n: number, mean: number[]): number[] {
  const out = new Array<number>(values.length).fill(NaN_);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const d = values[j] - mean[i];
      s += d * d;
    }
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

function macd(closes: number[]) {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const dif = closes.map((_, i) =>
    Number.isFinite(e12[i]) && Number.isFinite(e26[i]) ? e12[i] - e26[i] : NaN_,
  );
  const validFrom = dif.findIndex((v) => Number.isFinite(v));
  const dea: number[] = new Array(closes.length).fill(NaN_);
  if (validFrom >= 0) {
    const sub = dif.slice(validFrom);
    const deaSub = ema(sub, 9);
    for (let i = 0; i < deaSub.length; i++) dea[validFrom + i] = deaSub[i];
  }
  const hist = dif.map((d, i) =>
    Number.isFinite(d) && Number.isFinite(dea[i]) ? (d - dea[i]) * 2 : NaN_,
  );
  return { dif, dea, hist };
}

function kdj(bars: Bar[], n = 9) {
  const len = bars.length;
  const K = new Array<number>(len).fill(NaN_);
  const D = new Array<number>(len).fill(NaN_);
  const J = new Array<number>(len).fill(NaN_);
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < len; i++) {
    if (i < n - 1) continue;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    const rsv = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
    const k = (2 / 3) * prevK + (1 / 3) * rsv;
    const d = (2 / 3) * prevD + (1 / 3) * k;
    K[i] = k;
    D[i] = d;
    J[i] = 3 * k - 2 * d;
    prevK = k;
    prevD = d;
  }
  return { K, D, J };
}

function rsi(closes: number[], n: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN_);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (n - 1) + g) / n;
    avgLoss = (avgLoss * (n - 1) + l) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function atr(bars: Bar[], n = 14): number[] {
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      tr.push(bars[i].high - bars[i].low);
    } else {
      const pc = bars[i - 1].close;
      tr.push(
        Math.max(
          bars[i].high - bars[i].low,
          Math.abs(bars[i].high - pc),
          Math.abs(bars[i].low - pc),
        ),
      );
    }
  }
  const out = new Array<number>(bars.length).fill(NaN_);
  if (bars.length < n) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += tr[i];
  let prev = sum / n;
  out[n - 1] = prev;
  for (let i = n; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr[i]) / n;
    out[i] = prev;
  }
  return out;
}

function obv(bars: Bar[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      const diff = bars[i].close - bars[i - 1].close;
      if (diff > 0) acc += bars[i].volume;
      else if (diff < 0) acc -= bars[i].volume;
    }
    out.push(acc);
  }
  return out;
}

/** 一次性计算全套指标（全量模式） */
export function calcIndicators(bars: Bar[]): IndicatorSeries {
  const closes = bars.map((b) => b.close);
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const bollMid = ma20;
  const sd = stddev(closes, 20, bollMid);
  const bollUp = bollMid.map((m, i) => (Number.isFinite(sd[i]) ? m + 2 * sd[i] : NaN_));
  const bollDn = bollMid.map((m, i) => (Number.isFinite(sd[i]) ? m - 2 * sd[i] : NaN_));
  const m = macd(closes);
  const k = kdj(bars);
  const r6 = rsi(closes, 6);
  const r12 = rsi(closes, 12);
  const a14 = atr(bars, 14);
  const ob = obv(bars);

  return {
    date: bars.map((b) => b.date),
    ma5,
    ma10,
    ma20,
    ma60,
    bollUp,
    bollMid,
    bollDn,
    macdDif: m.dif,
    macdDea: m.dea,
    macdHist: m.hist,
    kdjK: k.K,
    kdjD: k.D,
    kdjJ: k.J,
    rsi6: r6,
    rsi12: r12,
    atr14: a14,
    obv: ob,
  };
}
