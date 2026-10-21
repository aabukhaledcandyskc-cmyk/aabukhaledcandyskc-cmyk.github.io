// Status of a ratio shown as a bar. "none" (no base to measure against) is deliberately different from "bad" (0% of a real base).
export const DEFAULT_THRESHOLDS = { warn: 50, good: 80 };
export const STATUS_ICON = { bad: '▼', warn: '◆', good: '✓', none: '' };

export function pctStatus(pct, hasBase = true, th = DEFAULT_THRESHOLDS) {
  if (pct === null || pct === undefined || Number.isNaN(pct) || !hasBase) return 'none';
  if (pct < th.warn) return 'bad';
  if (pct < th.good) return 'warn';
  return 'good';
}

// Accepts user input; falls back to the defaults unless 0 <= warn < good <= 200.
export function normalizeThresholds(warn, good) {
  const w = Number(warn), g = Number(good);
  return Number.isFinite(w) && Number.isFinite(g) && w >= 0 && w < g && g <= 200 ? { warn: w, good: g } : { ...DEFAULT_THRESHOLDS };
}

// 63 -> "63", 39.94 -> "39.9", 100 -> "100" (no trailing .0)
export const fmtPct = (p) => `${+Number(p).toFixed(1)}%`;

export const barWidth = (pct) => Math.max(0, Math.min(100, pct));
export const overflows = (pct) => pct > 100.05;
