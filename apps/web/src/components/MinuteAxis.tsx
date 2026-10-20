import { useEffect, useState } from 'react';
import type { IChartApi } from 'lightweight-charts';

/**
 * 分时图底部时间轴，自绘。
 *
 * 为什么不用 lightweight-charts 自带的刻度：11:30 与 13:00 在图上只隔一根
 * （午休被压缩），库的重叠检测会把这两个刻度一起丢掉，导致下午的 14:00 前面
 * 只剩 11:00 —— 和同花顺对不上。这里把分时的时间轴整个关掉（timeScale.visible
 * = false），标签自己画，位置用 logicalToCoordinate 换算，缩放跟着走。
 */

/** 轴区高度，调用方要把它从图表高度里扣掉 */
export const MINUTE_AXIS_HEIGHT = 20;

interface MarkDef {
  /** 数据里的时间点；mergeTo 存在时取两点中点（午休那一格） */
  at: string;
  mergeTo?: string;
  text: string;
  anchor: 'l' | 'c' | 'r';
}

const MARKS: MarkDef[] = [
  { at: '09:30', text: '9:30', anchor: 'l' },
  { at: '10:30', text: '10:30', anchor: 'c' },
  { at: '11:30', mergeTo: '13:00', text: '11:30/13:00', anchor: 'c' },
  { at: '14:00', text: '14:00', anchor: 'c' },
  { at: '15:00', text: '15:00', anchor: 'r' },
];

interface Mark {
  left: number;
  text: string;
  anchor: 'l' | 'c' | 'r';
}

export default function MinuteAxis({
  chart,
  times,
}: {
  chart: IChartApi | null;
  /** 分时数据的时间序列（"09:30" 这种），用于定位刻度 */
  times: string[];
}) {
  const [marks, setMarks] = useState<Mark[]>([]);
  // 数组每次渲染都是新引用，依赖它会把 effect 打成死循环，故用拼接后的 key
  const key = times.join('|');

  useEffect(() => {
    if (!chart || !times.length) {
      setMarks([]);
      return;
    }

    const place = () => {
      const ts = chart.timeScale();
      const at = (t: string) => times.indexOf(t);
      const coord = (i: number): number | null =>
        i < 0 ? null : (ts.logicalToCoordinate(i as never) as number | null);

      const next: Mark[] = [];
      for (const m of MARKS) {
        const i = at(m.at);
        if (i < 0) continue;
        let x = coord(i);
        if (x === null) continue;
        if (m.mergeTo) {
          const j = at(m.mergeTo);
          const x2 = coord(j);
          // 午休只剩一根的距离，取中点才落在视觉上的「缝」里
          if (x2 !== null) x = (x + x2) / 2;
        }
        // 平移到画布左侧之外的点不标；右侧交给容器的 overflow 裁掉
        if (x < -2) continue;
        next.push({ left: Math.round(x), text: m.text, anchor: m.anchor });
      }
      setMarks(next);
      return next.length > 0;
    };

    // fitContent / 缩放 / 容器变化都会改可见范围，所以跟着范围变化重排，
    // 只在第一次渲染时量一次会拿到 fitContent 之前的旧坐标
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    };

    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(schedule);
    window.addEventListener('resize', schedule);

    // 弹窗里子组件的 effect 先于父组件「把数据塞进图表」的那个，
    // 首次量出来会是空；没量到就补几次，量到为止
    const timers: number[] = [];
    const retry = (n: number) => {
      if (n <= 0) return;
      timers.push(window.setTimeout(() => (place() ? undefined : retry(n - 1)), 100));
    };
    if (!place()) retry(6);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      for (const t of timers) window.clearTimeout(t);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [chart, key]);

  if (!marks.length) return null;

  return (
    <div className="minute-axis" aria-hidden>
      {marks.map((m) => (
        <span
          key={m.text}
          className="minute-axis-tick"
          style={{
            left: m.left,
            transform:
              m.anchor === 'l' ? 'none' : m.anchor === 'r' ? 'translateX(-100%)' : 'translateX(-50%)',
          }}
        >
          {m.text}
        </span>
      ))}
    </div>
  );
}
