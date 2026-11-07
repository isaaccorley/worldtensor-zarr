import "maplibre-gl/dist/maplibre-gl.css";
import type maplibregl from "maplibre-gl";
import "./styles.css";
import { createColormapTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Device, Texture } from "@luma.gl/core";
import type { Catalog, Variable } from "./catalog.js";
import { loadCatalog, yearsOf } from "./catalog.js";
import type { ColormapName } from "./colormaps.js";
import { COLORMAP_INDEX, defaultColormap, loadSprite } from "./colormaps.js";
import { fmt, fmtLatLng } from "./format.js";
import type { Sources } from "./layers.js";
import { buildLayers, openSources } from "./layers.js";
import type { MapHandles } from "./map.js";
import { createMap, globeGlow, pinMarker } from "./map.js";
import { Probe, readSeries } from "./probe.js";
import { ViewerStore } from "./store.js";
import { $, bindUi, renderInspector, renderLegend, renderList, renderTimeline } from "./ui.js";
import { readHash, writeHash } from "./url.js";

// zarrita's FetchStore needs an absolute URL
const DATA_URL = new URL(
  (import.meta.env.VITE_DATA_URL as string | undefined) ?? "data",
  location.href,
).href.replace(/\/$/, "");

export type State = {
  catalog: Catalog;
  store: ViewerStore;
  variable: Variable;
  years: number[];
  yearIdx: number;
  /** year the detail layer shows; null while playing/scrubbing */
  detailYearIdx: number | null;
  playing: boolean;
  fps: number;
  cmap: ColormapName;
  reversed: boolean;
  vmin: number;
  vmax: number;
  opacity: number;
  domain: string | null;
  query: string;
  pin: { lng: number; lat: number; series: Float32Array | null } | null;
  sprite: ImageData;
};

let state: State;
let handles: MapHandles;
let sources: Sources | null = null;
let probe: Probe | null = null;
let colormapTexture: Texture | null = null;
let device: Device | null = null;
let openToken = 0;
/** last year the detail layer settled on; its selection stays here while hidden */
let settledYearIdx = 0;

/** Push the current state to deck.gl. Cheap: only uniforms change on scrub. */
function draw() {
  if (!sources || !colormapTexture) return;
  handles.overlay.setProps({
    layers: buildLayers({
      sources,
      variable: state.variable,
      yearIdx: state.yearIdx,
      detailYearIdx: settledYearIdx,
      showDetail: state.detailYearIdx !== null,
      beforeId: handles.beforeId,
      style: {
        colormapTexture,
        colormapIndex: COLORMAP_INDEX[state.cmap],
        reversed: state.reversed,
        vmin: state.vmin,
        vmax: state.vmax,
        opacity: state.opacity,
      },
    }),
  });
}

export function update(patch: Partial<State>, opts: { redraw?: boolean } = {}) {
  Object.assign(state, patch);
  if (state.detailYearIdx !== null) settledYearIdx = state.detailYearIdx;
  renderTimeline(state);
  renderLegend(state);
  renderInspector(state);
  if (opts.redraw !== false) draw();
  writeHash(state, handles.map);
}

let settleTimer = 0;
/** Show year `i` instantly from the overview; sharpen with detail once idle. */
export function setYear(i: number) {
  const yearIdx = Math.max(0, Math.min(state.years.length - 1, i));
  update({ yearIdx, detailYearIdx: null });
  clearTimeout(settleTimer);
  if (!state.playing) {
    settleTimer = window.setTimeout(() => update({ detailYearIdx: state.yearIdx }), 220);
  }
}

export function setPlaying(playing: boolean) {
  update({ playing, detailYearIdx: playing ? null : state.yearIdx });
}

export async function selectVariable(v: Variable, keep?: Partial<State>) {
  const token = ++openToken;
  const years = yearsOf(v);
  const cm = defaultColormap(v);
  const yearIdx = keep?.yearIdx ?? Math.max(0, years.length - 1);
  state.variable = v;
  renderList(state);
  const next = await openSources(state.store, state.catalog, v);
  if (token !== openToken) return; // a newer selection won the race
  sources = next;
  probe = new Probe(state.store, state.catalog, v);
  update({
    years,
    yearIdx: Math.min(yearIdx, Math.max(0, years.length - 1)),
    detailYearIdx: state.playing ? null : yearIdx,
    cmap: keep?.cmap ?? cm.name,
    reversed: keep?.reversed ?? cm.reversed,
    vmin: keep?.vmin ?? v.range.p2 ?? v.range.min ?? 0,
    vmax: keep?.vmax ?? v.range.p98 ?? v.range.max ?? 1,
  });
  if (state.pin) void inspect(state.pin.lng, state.pin.lat);
}

const pin = { marker: null as ReturnType<typeof pinMarker> | null };

export async function inspect(lng: number, lat: number) {
  pin.marker?.show(lng, lat);
  const v = state.variable;
  update({ pin: { lng, lat, series: null } }, { redraw: false });
  const series = await readSeries(state.store, state.catalog, v, lng, lat);
  if (state.variable !== v || state.pin?.lng !== lng) return;
  update({ pin: { lng, lat, series } }, { redraw: false });
}

export function clearPin() {
  pin.marker?.hide();
  update({ pin: null }, { redraw: false });
}

function startLoop() {
  let last = performance.now();
  const tick = (now: number) => {
    if (state?.playing && state.years.length > 1 && now - last >= 1000 / state.fps) {
      last = now;
      update({ yearIdx: (state.yearIdx + 1) % state.years.length });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function wireMap() {
  const { map } = handles;
  const readout = $("readout");
  // on a globe, unproject clamps cursors past the limb onto the horizon;
  // a point is on the globe only if it projects back to where the cursor is
  const onGlobe = (e: maplibregl.MapMouseEvent) => {
    const back = map.project(e.lngLat);
    return Math.hypot(back.x - e.point.x, back.y - e.point.y) < 2;
  };
  map.on("mousemove", async (e) => {
    if (!probe) return;
    if (!onGlobe(e)) {
      readout.hidden = true;
      return;
    }
    const { lng, lat } = e.lngLat;
    const coarse = state.playing || state.detailYearIdx === null;
    const val = await probe.valueAt(lng, lat, state.yearIdx, coarse).catch(() => null);
    if (val === null) {
      readout.hidden = true;
      return;
    }
    readout.hidden = false;
    readout.style.transform = `translate(${e.originalEvent.clientX + 16}px, ${e.originalEvent.clientY + 16}px)`;
    readout.innerHTML = `<b>${fmt(val)}</b> ${state.variable.units ?? ""}<br><span>${fmtLatLng(lng, lat)}</span>`;
  });
  map.on("mouseout", () => (readout.hidden = true));
  map.on("click", (e) => onGlobe(e) && void inspect(e.lngLat.lng, e.lngLat.lat));
  map.on("moveend", () => writeHash(state, map));
}

async function boot() {
  const bootMsg = $("boot-msg");
  const hash = readHash();
  const [catalog, sprite] = await Promise.all([loadCatalog(DATA_URL), loadSprite()]);
  const store = new ViewerStore(DATA_URL, catalog);
  store.onActivity = (n) => $("led").classList.toggle("busy", n > 0);

  const initial =
    catalog.variables.find((v) => v.path === hash.v) ??
    catalog.variables.find((v) => v.path === "climate/t2m_mean") ??
    catalog.variables[0]!;
  const firstYears = yearsOf(initial);
  const minYear = Math.min(...catalog.variables.flatMap((v) => yearsOf(v).slice(0, 1)));
  const maxYear = Math.max(...catalog.variables.flatMap((v) => yearsOf(v).slice(-1)));
  $("kicker").textContent = `${catalog.variables.length} variables · ${minYear}–${maxYear}`;

  state = {
    catalog, store, sprite,
    variable: initial,
    years: firstYears,
    yearIdx: firstYears.length - 1,
    detailYearIdx: firstYears.length - 1,
    playing: false,
    fps: 6,
    cmap: "viridis",
    reversed: false,
    vmin: 0,
    vmax: 1,
    opacity: 0.95,
    domain: null,
    query: "",
    pin: null,
  };

  bootMsg.textContent = "Spinning up the globe";
  handles = await createMap($("map"), { center: hash.center ?? [10, 20], zoom: hash.zoom ?? 2.05 }, (d) => {
    device = d;
    colormapTexture = createColormapTexture(d, sprite);
    draw();
  });
  pin.marker = pinMarker(handles.map);
  globeGlow(handles.map, $("glow"), $("caption"));
  bindUi(state, {
    selectVariable: (v) => void selectVariable(v),
    setYear,
    setPlaying,
    update,
    clearPin,
  });
  wireMap();
  startLoop();

  const yearIdx = hash.year !== undefined ? firstYears.indexOf(hash.year) : -1;
  await selectVariable(initial, {
    ...(yearIdx >= 0 ? { yearIdx } : {}),
    ...(hash.cmap && hash.cmap in COLORMAP_INDEX ? { cmap: hash.cmap as ColormapName } : {}),
  });
  if (!device) bootMsg.textContent = "Waiting for WebGL";
  $("boot").classList.add("done");
}

boot().catch((err) => {
  console.error(err);
  $("boot-msg").textContent = `Failed to load: ${err.message ?? err}`;
});
