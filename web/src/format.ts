/** Compact, magnitude-aware number formatting for readouts and legends. */
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a === 0) return "0";
  if (a >= 1e5 || a < 1e-3) return n.toExponential(2).replace("e+", "e");
  if (a >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 100) return n.toFixed(1);
  if (a >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

export function fmtLatLng(lng: number, lat: number): string {
  const lon = ((((lng + 180) % 360) + 360) % 360) - 180;
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${ns}  ${Math.abs(lon).toFixed(2)}°${ew}`;
}

/** OLS slope per decade over finite values, or null with < 3 points. */
export function trendPerDecade(years: number[], values: ArrayLike<number>): number | null {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < years.length; i++) {
    const y = values[i]!;
    if (!Number.isFinite(y)) continue;
    const x = years[i]!;
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  if (n < 3) return null;
  const den = n * sxx - sx * sx;
  return den === 0 ? null : ((n * sxy - sx * sy) / den) * 10;
}

/** Area + line SVG of a series with a marker at `cur`. */
export function sparkline(
  years: number[],
  values: ArrayLike<number>,
  cur: number,
  w = 304,
  h = 92,
): string {
  const pad = { l: 2, r: 2, t: 8, b: 4 };
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < years.length; i++) {
    const v = values[i]!;
    if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  if (!Number.isFinite(lo)) return `<div class="ts-empty">no data at this pixel</div>`;
  if (hi === lo) { hi += 1; lo -= 1; }
  const x = (i: number) => pad.l + (i / Math.max(1, years.length - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  let line = "";
  let started = false;
  for (let i = 0; i < years.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) { started = false; continue; }
    line += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    started = true;
  }
  const first = years.findIndex((_, i) => Number.isFinite(values[i]!));
  let last = years.length - 1;
  while (last > 0 && !Number.isFinite(values[last]!)) last--;
  const area = `${line}L${x(last).toFixed(1)},${h}L${x(first).toFixed(1)},${h}Z`;
  const cv = values[cur];
  const dot = cv !== undefined && Number.isFinite(cv)
    ? `<circle cx="${x(cur)}" cy="${y(cv)}" r="3.5" class="ts-dot"/>`
    : "";
  return `<svg viewBox="0 0 ${w} ${h}" class="ts-svg" preserveAspectRatio="none">
    <defs><linearGradient id="tsfill" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity="0.38"/>
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#tsfill)"/>
    <path d="${line}" class="ts-line"/>
    <line x1="${x(cur)}" x2="${x(cur)}" y1="0" y2="${h}" class="ts-cursor"/>
    ${dot}
  </svg>`;
}
