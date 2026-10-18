import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { cls, fmtNum, fmtPct } from '../fmt';

/** 两位数补零 */
const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
const hhmmss = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** 每秒走一次的本机时钟，供盘口标题右侧显示 */
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // 对齐到整秒再起跳，避免与系统秒数错位
    let timer = 0;
    const tick = () => setNow(new Date());
    const wait = 1000 - (Date.now() % 1000);
    const boot = window.setTimeout(() => {
      tick();
      timer = window.setInterval(tick, 1000);
    }, wait);
    return () => {
      window.clearTimeout(boot);
      window.clearInterval(timer);
    };
  }, []);
  return now;
}

export default function OrderBook() {
  const { quotes, selected } = useStore();
  const now = useClock();
  const q = quotes[selected];

  if (!q) {
    return (
      <div className="rightbar">
        <div className="empty">暂无盘口数据</div>
      </div>
    );
  }

  const asks = [...q.asks].reverse();
  const bids = q.bids;
  const maxVol = Math.max(
    1,
    ...asks.map((a) => a.volume),
    ...bids.map((b) => b.volume),
  );

  const bar = (vol: number, color: string) => ({
    background: `linear-gradient(to left, ${color} 0%, ${color} ${(vol / maxVol) * 100}%, transparent ${
      (vol / maxVol) * 100
    }%)`,
  });

  return (
    <div className="rightbar">
      <div className="section-title">
        <span>五档盘口</span>
        <span className="sec-clock" title={`本机时间 · 行情快照 ${q.time}`}>
          {hhmmss(now)}
        </span>
      </div>
      <div className="book">
        <div className="book-price-lg">
          <span className={`num ${cls(q.changePct)}`} style={{ fontSize: 20, fontWeight: 600 }}>
            {fmtNum(q.price)}
          </span>
          <span className={`num ${cls(q.changePct)}`}>
            {q.change > 0 ? '+' : ''}
            {fmtNum(q.change)} {fmtPct(q.changePct)}
          </span>
        </div>

        {asks.map((a, i) => (
          <div className="book-row" key={`a${i}`} style={bar(a.volume, 'rgba(217,48,38,0.07)')}>
            <span style={{ color: 'var(--text-3)' }}>卖{5 - i}</span>
            <span className="num up">{fmtNum(a.price)}</span>
            <span className="num">{a.volume.toFixed(0)}</span>
          </div>
        ))}

        <div className="book-sep" />

        {bids.map((b, i) => (
          <div className="book-row" key={`b${i}`} style={bar(b.volume, 'rgba(18,137,79,0.07)')}>
            <span style={{ color: 'var(--text-3)' }}>买{i + 1}</span>
            <span className="num down">{fmtNum(b.price)}</span>
            <span className="num">{b.volume.toFixed(0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
