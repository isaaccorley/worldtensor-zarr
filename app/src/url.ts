import type maplibregl from "maplibre-gl";
import type { State } from "./main.js";

export type HashState = {
  v?: string;
  year?: number;
  cmap?: string;
  center?: [number, number];
  zoom?: number;
};

/** `#v=climate/t2m_mean&y=2025&c=thermal&@=10.0,20.0,1.6` */
export function readHash(): HashState {
  const p = new URLSearchParams(location.hash.slice(1));
  const out: HashState = {};
  if (p.get("v")) out.v = p.get("v")!;
  if (p.get("y")) out.year = Number(p.get("y"));
  if (p.get("c")) out.cmap = p.get("c")!;
  const cam = p.get("@")?.split(",").map(Number);
  if (cam?.length === 3 && cam.every(Number.isFinite)) {
    out.center = [cam[0]!, cam[1]!];
    out.zoom = cam[2]!;
  }
  return out;
}

let timer = 0;
export function writeHash(s: State, map: maplibregl.Map) {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    const c = map.getCenter();
    const p = new URLSearchParams();
    p.set("v", s.variable.path);
    if (s.years.length) p.set("y", String(s.years[s.yearIdx]));
    p.set("c", s.cmap);
    p.set("@", `${c.lng.toFixed(2)},${c.lat.toFixed(2)},${map.getZoom().toFixed(2)}`);
    history.replaceState(null, "", `#${decodeURIComponent(p.toString())}`);
  }, 300);
}
