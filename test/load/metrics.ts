/** Nearest-rank percentile over an unsorted sample. `p` is in (0, 100]. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Least-squares slope of y over t. Used to detect steady growth (leaks). */
export function slope(points: { t: number; y: number }[]): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const meanT = points.reduce((sum, p) => sum + p.t, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - meanT) * (p.y - meanY);
    den += (p.t - meanT) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
