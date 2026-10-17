import { useStore } from '../store';
import { cls, fmtAmount, fmtNum, fmtPct, fmtVolume } from '../fmt';

export default function OrderBook() {
  const { quotes, selected, items } = useStore();
  const q = quotes[selected];
  const name = q?.name || items.find((i) => i.symbol === selected)?.name || '--';

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
      <div className="section-title">五档盘口</div>
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

      <div className="section-title">关键数据</div>
      <div style={{ padding: '8px 12px' }}>
        <div className="kv">
          <span>今开</span>
          <span className={`num ${cls(q.open - q.prevClose)}`}>{fmtNum(q.open)}</span>
        </div>
        <div className="kv">
          <span>昨收</span>
          <span className="num">{fmtNum(q.prevClose)}</span>
        </div>
        <div className="kv">
          <span>最高</span>
          <span className={`num ${cls(q.high - q.prevClose)}`}>{fmtNum(q.high)}</span>
        </div>
        <div className="kv">
          <span>最低</span>
          <span className={`num ${cls(q.low - q.prevClose)}`}>{fmtNum(q.low)}</span>
        </div>
        <div className="kv">
          <span>成交量</span>
          <span className="num">{fmtVolume(q.volume)}</span>
        </div>
        <div className="kv">
          <span>成交额</span>
          <span className="num">{fmtAmount(q.amount)}</span>
        </div>
        <div className="kv">
          <span>换手率</span>
          <span className="num">{fmtNum(q.turnoverRate)}%</span>
        </div>
        <div className="kv">
          <span>量比</span>
          <span className="num">{fmtNum(q.volumeRatio)}</span>
        </div>
        <div className="kv">
          <span>振幅</span>
          <span className="num">{fmtNum(q.amplitude)}%</span>
        </div>
        <div className="kv">
          <span>市盈率</span>
          <span className="num">{q.pe ? fmtNum(q.pe) : '--'}</span>
        </div>
        <div className="kv">
          <span>市净率</span>
          <span className="num">{q.pb ? fmtNum(q.pb) : '--'}</span>
        </div>
        <div className="kv">
          <span>总市值</span>
          <span className="num">{fmtAmount(q.marketCap)}</span>
        </div>
        <div className="kv">
          <span>流通市值</span>
          <span className="num">{fmtAmount(q.floatCap)}</span>
        </div>
      </div>

      <div className="section-title">三三卖点档位</div>
      <div style={{ padding: '8px 12px' }}>
        {[3, 6, 9].map((p) => {
          const target = q.open * (1 + p / 100);
          const hit = q.price >= target;
          const gap = ((target - q.price) / q.price) * 100;
          return (
            <div className="kv" key={p}>
              <span>+{p}%</span>
              <span className="num" style={{ color: hit ? 'var(--up)' : 'var(--text-2)' }}>
                {fmtNum(target)}
                <span style={{ color: 'var(--text-3)', marginLeft: 6 }}>
                  {hit ? '已触及' : `差 ${gap.toFixed(1)}%`}
                </span>
              </span>
            </div>
          );
        })}
        <div className="kv" style={{ marginTop: 4 }}>
          <span>标的</span>
          <span className="num">{name}</span>
        </div>
      </div>
    </div>
  );
}
