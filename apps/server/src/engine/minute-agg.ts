import type { Bar, MinutePoint } from '../types.js';

/**
 * 交易分钟序号：09:30-11:30 为 0..119，13:00-15:00 为 120..239。
 * 非交易时段返回 -1。
 */
export function minuteIndex(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m;
  if (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) return t - (9 * 60 + 30);
  if (t >= 13 * 60 && t <= 15 * 60) return 120 + (t - 13 * 60);
  if (t === 11 * 60 + 31) return 119;
  return -1;
}

/** 把 1 分钟分时聚合为 N 分钟 K 线 */
export function aggregateMinute(points: MinutePoint[], minutes: number, date: string): Bar[] {
  if (minutes <= 1) {
    return points.map((p) => ({
      date: `${date} ${p.time}`,
      open: p.price,
      high: p.price,
      low: p.price,
      close: p.price,
      volume: p.volume,
    }));
  }

  const buckets = new Map<number, Bar>();
  for (const p of points) {
    const idx = minuteIndex(p.time);
    if (idx < 0) continue;
    const key = Math.floor(idx / minutes);
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, {
        date: bucketLabel(key, minutes, date),
        open: p.price,
        high: p.price,
        low: p.price,
        close: p.price,
        volume: p.volume,
      });
    } else {
      cur.high = Math.max(cur.high, p.price);
      cur.low = Math.min(cur.low, p.price);
      cur.close = p.price;
      cur.volume += p.volume;
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bar]) => bar);
}

function bucketLabel(key: number, minutes: number, date: string): string {
  const startIdx = key * minutes;
  let total: number;
  if (startIdx < 120) {
    total = 9 * 60 + 30 + startIdx;
  } else {
    total = 13 * 60 + (startIdx - 120);
  }
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

/** 从日 K 聚合周 K（腾讯已提供原生周 K，这里仅作为兜底） */
export function aggregateWeek(bars: Bar[]): Bar[] {
  const map = new Map<string, Bar>();
  for (const b of bars) {
    const d = new Date(b.date + 'T00:00:00Z');
    const day = (d.getUTCDay() + 6) % 7;
    const monday = new Date(d.getTime() - day * 86400000);
    const key = monday.toISOString().slice(0, 10);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ...b, date: key });
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}
