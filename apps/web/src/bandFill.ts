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
 * 大智慧 FILLRGN 的移植：把指标线与一条水平基准线之间的区域涂色。
 *
 * lightweight-charts 没有「两条线之间填充」的序列（AreaSeries 只能填到价格轴底），
 * 所以在基元里直接画多边形：把满足条件的连续一撮 bar 依次连成上边界，
 * 再沿基准线折回闭合。
 *
 * 坐标系和日志坐标都取自挂载它的那条线，所以必须 attach 到副图里同窗格的序列上，
 * 否则价格轴不是同一套、y 会算错。
 */

export interface BandFillData {
  /** 指标值，与 K 线等长，NaN 处断开 */
  values: number[];
  /** 水平基准线（逃顶 80 / 吸货 20） */
  base: number;
  /** true：只填 values > base 的上方；false：只填下方 */
  above: boolean;
  /** 填充色，建议带透明度，免得糊住指标线 */
  color: string;
}

class BandRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _polys: number[][],
    private readonly _color: string,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._polys.length) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.fillStyle = this._color;
      for (const pts of this._polys) {
        ctx.beginPath();
        ctx.moveTo(pts[0], pts[1]);
        for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        ctx.closePath();
        ctx.fill();
      }
    });
  }
}

class BandView implements IPrimitivePaneView {
  private _renderer: IPrimitivePaneRenderer;

  constructor(private readonly _p: BandFillPrimitive) {
    this._renderer = new BandRenderer([], 'transparent');
  }

  update(): void {
    this._renderer = this._p.build();
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }

  /** 垫在指标线下面 */
  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom';
  }
}

export class BandFillPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<'Line', Time> | null = null;
  private readonly _views: BandView[] = [new BandView(this)];

  constructor(private readonly _data: BandFillData) {}

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart as IChartApi;
    this._series = param.series as ISeriesApi<'Line', Time>;
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

  /** 只处理视野内的点；平移缩放时由 updateAllViews 重新调用 */
  build(): IPrimitivePaneRenderer {
    const chart = this._chart;
    const series = this._series;
    const d = this._data;
    if (!chart || !series || !d.values.length) return new BandRenderer([], d.color);

    const yBase = series.priceToCoordinate(d.base);
    if (yBase === null) return new BandRenderer([], d.color);

    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    const n = d.values.length;
    const from = range ? Math.max(0, Math.floor(range.from) - 1) : 0;
    const to = range ? Math.min(n - 1, Math.ceil(range.to) + 1) : n - 1;

    const polys: number[][] = [];
    let cur: number[] | null = null;
    let firstX = 0;

    const flush = () => {
      if (!cur) return;
      // 沿基准线从右端折回左端，closePath 再从 (firstX, yBase) 竖直回到起点
      const lastX = cur[cur.length - 2];
      cur.push(lastX, yBase, firstX, yBase);
      polys.push(cur);
      cur = null;
    };

    for (let i = from; i <= to; i++) {
      const v = d.values[i];
      const hit = Number.isFinite(v) && (d.above ? v > d.base : v < d.base);
      const y = hit ? series.priceToCoordinate(v) : null;
      const x = ts.logicalToCoordinate(i as Logical);
      if (!hit || y === null || x === null) {
        flush();
        continue;
      }
      if (!cur) {
        cur = [];
        firstX = x;
      }
      cur.push(x, y);
    }
    flush();

    return new BandRenderer(polys, d.color);
  }
}
