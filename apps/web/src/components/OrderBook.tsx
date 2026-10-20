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

  /**
   * 以昨收为基准上色：高于昨收红、低于昨收绿、持平灰。
   * 卖档不一定全红、买档也不一定全绿——跳空高开时买档会整片红。
   */
  const prev = q.prevClose > 0 ? q.prevClose : 0;
  const side = (price: number): 'up' | 'down' | 'flat' =>
    prev > 0 && price > 0 ? cls(price - prev) : 'flat';
  const tone = { up: 'rgba(217,48,38,0.07)', down: 'rgba(18,137,79,0.07)', flat: 'transparent' } as const;
  /** 每档的量条跟着该档价格的颜色走，避免红价配绿底 */
  const bar = (price: number, vol: number) => {
    const c = tone[side(price)];
    return {
      background: `linear-gradient(to left, ${c} 0%, ${c} ${(vol / maxVol) * 100}%, transparent ${
        (vol / maxVol) * 100
      }%)`,
    };
  };
  /** 悬停提示：该档相对昨收的涨跌幅（昨收为 0 时不给） */
  const tip = (price: number) =>
    prev > 0 && price > 0 ? `${fmtNum(price)} · ${fmtPct(((price - prev) / prev) * 100)}` : undefined;

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
          <span className="book-chg">
            <span className={`num ${cls(q.changePct)}`}>
              {q.change > 0 ? '+' : ''}
              {fmtNum(q.change)} {fmtPct(q.changePct)}
            </span>
            <span className="book-prev num">昨收 {fmtNum(q.prevClose)}</span>
          </span>
        </div>

        {asks.map((a, i) => (
          <div className="book-row" key={`a${i}`} style={bar(a.price, a.volume)} title={tip(a.price)}>
            <span style={{ color: 'var(--text-3)' }}>卖{5 - i}</span>
            <span className={`num ${side(a.price)}`}>{fmtNum(a.price)}</span>
            <span className="num">{a.volume.toFixed(0)}</span>
          </div>
        ))}

        <div className="book-sep" />

        {bids.map((b, i) => (
          <div className="book-row" key={`b${i}`} style={bar(b.price, b.volume)} title={tip(b.price)}>
            <span style={{ color: 'var(--text-3)' }}>买{i + 1}</span>
            <span className={`num ${side(b.price)}`}>{fmtNum(b.price)}</span>
            <span className="num">{b.volume.toFixed(0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
