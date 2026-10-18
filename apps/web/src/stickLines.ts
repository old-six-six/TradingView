import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';

/**
 * 大智慧 STICKLINE 的移植：在两根价格之间画一根竖柱。
 *
 * lightweight-charts 没有「两个价位之间的柱子」这种序列（柱状图只能从 0 起画），
 * 用序列基元（primitive）直接在画布上画最省事，也不用往图里塞几百个序列。
 */

export interface StickLinesData {
  /** 柱子上端（Var2 慢线） */
  top: number[];
  /** 柱子下端（Var3 快线） */
  bottom: number[];
  /** Var5 = top - bottom，≥0 用持仓色、<0 用减仓色 */
  diff: number[];
  holdColor: string;
  reduceColor: string;
  /** 柱子宽度占 K 线间距的比例，大智慧原值 0.5 */
  widthRatio?: number;
}

interface Seg {
  x: number;
  y0: number;
  y1: number;
  color: string;
}

class StickRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _segs: Seg[],
    private readonly _width: number,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._segs.length) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const w = this._width;
      const half = w / 2;
      for (const s of this._segs) {
        ctx.fillStyle = s.color;
        ctx.fillRect(s.x - half, s.y0, w, Math.max(1, s.y1 - s.y0));
      }
    });
  }
}

class StickView implements IPrimitivePaneView {
  private _renderer: IPrimitivePaneRenderer = new StickRenderer([], 1);

  constructor(private readonly _p: StickLinesPrimitive) {}

  update(): void {
    this._renderer = this._p.build();
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }

  /** 画在 K 线下面，免得挡住实体 */
  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom';
  }
}

export class StickLinesPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<'Candlestick', Time> | null = null;
  private readonly _views: StickView[] = [new StickView(this)];

  constructor(private readonly _data: StickLinesData) {}

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart as IChartApi;
    this._series = param.series as unknown as ISeriesApi<'Candlestick', Time>;
  }

  detached(): void {
    this._chart = null;
    this._series = null;
  }

  updateAllViews(): void {
    for (const v of this._views) v.update();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }

  /** 只算视野内的柱子；视野变化时由 updateAllViews 重新调用 */
  build(): IPrimitivePaneRenderer {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series) return new StickRenderer([], 1);

    const d = this._data;
    const n = Math.min(d.top.length, d.bottom.length, d.diff.length);
    if (!n) return new StickRenderer([], 1);

    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    const from = range ? Math.max(0, Math.floor(range.from) - 1) : 0;
    const to = range ? Math.min(n - 1, Math.ceil(range.to) + 1) : n - 1;

    const segs: Seg[] = [];
    for (let i = from; i <= to; i++) {
      const a = d.top[i];
      const b = d.bottom[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const ya = series.priceToCoordinate(a);
      const yb = series.priceToCoordinate(b);
      const x = ts.logicalToCoordinate(i as Logical);
      if (ya === null || yb === null || x === null) continue;
      segs.push({
        x,
        y0: Math.min(ya, yb),
        y1: Math.max(ya, yb),
        color: d.diff[i] >= 0 ? d.holdColor : d.reduceColor,
      });
    }

    // 宽度跟着 K 线间距走：取 0、1 两格的坐标差，缩到很近时至少留 1px
    let spacing = 8;
    const x0 = ts.logicalToCoordinate(0 as Logical);
    const x1 = ts.logicalToCoordinate(1 as Logical);
    if (x0 !== null && x1 !== null && x1 > x0) spacing = x1 - x0;
    const width = Math.max(1, spacing * (d.widthRatio ?? 0.5));

    return new StickRenderer(segs, width);
  }
}
