export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return v.toFixed(digits);
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export function fmtAmount(v: number | null | undefined): string {
  if (!v || !Number.isFinite(v)) return '--';
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)} 万`;
  return v.toFixed(0);
}

export function fmtVolume(hands: number | null | undefined): string {
  if (!hands || !Number.isFinite(hands)) return '--';
  if (hands >= 1e4) return `${(hands / 1e4).toFixed(2)} 万手`;
  return `${hands.toFixed(0)} 手`;
}

export function cls(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}
