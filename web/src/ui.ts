import type { Variable } from "./catalog.js";
import { DOMAIN_LABELS, labelOf } from "./catalog.js";
import type { ColormapName } from "./colormaps.js";
import { PICKER, swatchUrl } from "./colormaps.js";
import { fmt, fmtLatLng, sparkline, trendPerDecade } from "./format.js";
import type { State } from "./main.js";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

export type Actions = {
  selectVariable: (v: Variable) => void;
  setYear: (i: number) => void;
  setPlaying: (p: boolean) => void;
  update: (patch: Partial<State>, opts?: { redraw?: boolean }) => void;
  clearPin: () => void;
};

let actions: Actions;
let listKey = "";

function matches(v: Variable, q: string): boolean {
  if (!q) return true;
  const hay = `${v.path} ${v.long_name ?? ""} ${v.units ?? ""}`.toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

export function renderList(s: State) {
  const key = `${s.domain}|${s.query}|${s.variable.path}`;
  if (key === listKey) return;
  const rebuild = listKey.split("|").slice(0, 2).join("|") !== `${s.domain}|${s.query}`;
  listKey = key;

  const counts = new Map<string, number>();
  for (const v of s.catalog.variables) {
    if (matches(v, s.query)) counts.set(v.domain, (counts.get(v.domain) ?? 0) + 1);
  }
  $("domains").innerHTML = [...counts.keys()]
    .sort()
    .map(
      (d) =>
        `<button class="dchip${s.domain === d ? " is-active" : ""}" data-domain="${d}">${
          DOMAIN_LABELS[d] ?? d
        }<span>${counts.get(d)}</span></button>`,
    )
    .join("");

  const list = $("vars");
  if (rebuild) {
    const shown = s.catalog.variables.filter(
      (v) => (!s.domain || v.domain === s.domain) && matches(v, s.query),
    );
    list.innerHTML = shown
      .map(
        (v, i) => `<li class="var" data-path="${v.path}" style="--i:${Math.min(i, 24)}">
          <span class="var-name">${v.path.split("/").slice(1).join("/")}</span>
          <span class="var-label">${labelOf(v)}</span>
          <span class="var-meta">${DOMAIN_LABELS[v.domain] ?? v.domain}${v.units ? ` · ${v.units}` : ""}${
            v.years ? "" : " · static"
          }</span>
        </li>`,
      )
      .join("") || `<li class="var-empty">No variables match “${s.query}”</li>`;
  }
  for (const li of list.querySelectorAll<HTMLElement>(".var")) {
    const active = li.dataset.path === s.variable.path;
    li.classList.toggle("is-active", active);
    if (active && rebuild) li.scrollIntoView({ block: "center" });
  }
}

export function renderTimeline(s: State) {
  const v = s.variable;
  $("var-domain").textContent = DOMAIN_LABELS[v.domain] ?? v.domain;
  $("var-title").textContent = labelOf(v);
  $("var-sub").textContent = `${v.path}${v.units ? `  ·  ${v.units}` : ""}`;
  const temporal = s.years.length > 1;
  $("timeline").classList.toggle("is-static", !temporal);
  $("timeline").classList.toggle("is-playing", s.playing);
  $("year").textContent = temporal ? String(s.years[s.yearIdx]) : "static";
  const slider = $<HTMLInputElement>("slider");
  slider.max = String(Math.max(0, s.years.length - 1));
  slider.value = String(s.yearIdx);
  slider.style.setProperty("--v", `${(s.yearIdx / Math.max(1, s.years.length - 1)) * 100}%`);
  const ticksKey = `${s.years[0]}-${s.years.length}`;
  const ticks = $("ticks");
  if (ticks.dataset.key !== ticksKey) {
    ticks.dataset.key = ticksKey;
    const n = s.years.length;
    const step = n > 90 ? 20 : n > 40 ? 10 : 5;
    ticks.innerHTML = s.years
      .map((y, i) => (y % step === 0 ? `<span style="left:${(i / Math.max(1, n - 1)) * 100}%">${y}</span>` : ""))
      .join("");
  }
}

export function renderLegend(s: State) {
  $("ramp").style.backgroundImage = `url(${swatchUrl(s.sprite, s.cmap, s.reversed)})`;
  const vmin = $<HTMLInputElement>("vmin");
  const vmax = $<HTMLInputElement>("vmax");
  if (document.activeElement !== vmin) vmin.value = fmt(s.vmin);
  if (document.activeElement !== vmax) vmax.value = fmt(s.vmax);
  $("units").textContent = s.variable.units ?? "";
  $("rev").classList.toggle("is-active", s.reversed);
  // colorbar ticks: 5 evenly spaced values across the rescale range
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  $("cbar-ticks").innerHTML = ticks
    .map((t) => `<span style="left:${t * 100}%">${fmt(s.vmin + t * (s.vmax - s.vmin))}</span>`)
    .join("");
  const grid = $("cmap-grid");
  if (!grid.dataset.ready) {
    grid.dataset.ready = "1";
    grid.innerHTML = PICKER.map(
      (n) => `<button class="swatch" data-cmap="${n}" title="${n}" style="background-image:url(${swatchUrl(s.sprite, n)})"><span>${n}</span></button>`,
    ).join("");
  }
  for (const b of grid.querySelectorAll<HTMLElement>(".swatch")) {
    b.classList.toggle("is-active", b.dataset.cmap === s.cmap);
  }
}

export function renderInspector(s: State) {
  const ins = $("inspector");
  if (!s.pin) {
    ins.hidden = true;
    return;
  }
  ins.hidden = false;
  $("ins-coord").textContent = fmtLatLng(s.pin.lng, s.pin.lat);
  $("ins-units").textContent = s.variable.units ?? "";
  const series = s.pin.series;
  if (!s.variable.arrays.ts) {
    $("ins-now").textContent = "static";
    $("ins-trend").textContent = "no time axis";
    $("ins-chart").innerHTML = "";
    $("ins-y0").textContent = $("ins-y1").textContent = "";
    return;
  }
  if (!series) {
    $("ins-now").textContent = "…";
    $("ins-trend").textContent = "reading pixel history";
    $("ins-chart").innerHTML = `<div class="ts-loading"></div>`;
    return;
  }
  $("ins-now").textContent = `${fmt(series[s.yearIdx])}`;
  const tr = trendPerDecade(s.years, series);
  $("ins-trend").innerHTML =
    tr === null
      ? `${s.years[s.yearIdx]}`
      : `${s.years[s.yearIdx]} · trend <b class="${tr >= 0 ? "up" : "down"}">${tr >= 0 ? "+" : ""}${fmt(tr)}</b> / decade`;
  $("ins-chart").innerHTML = sparkline(s.years, series, s.yearIdx);
  $("ins-y0").textContent = String(s.years[0]);
  $("ins-y1").textContent = String(s.years[s.years.length - 1]);
}

function parseNum(el: HTMLInputElement, fallback: number) {
  const n = Number.parseFloat(el.value.replaceAll(",", ""));
  return Number.isFinite(n) ? n : fallback;
}

export function bindUi(s: State, a: Actions) {
  actions = a;
  const q = $<HTMLInputElement>("q");
  q.addEventListener("input", () => {
    s.query = q.value.trim().toLowerCase();
    renderList(s);
  });
  $("domains").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-domain]");
    if (!b) return;
    s.domain = s.domain === b.dataset.domain ? null : b.dataset.domain!;
    renderList(s);
  });
  $("vars").addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
    const v = li && s.catalog.variables.find((x) => x.path === li.dataset.path);
    if (v) actions.selectVariable(v);
  });

  $("play").addEventListener("click", () => actions.setPlaying(!s.playing));
  const slider = $<HTMLInputElement>("slider");
  slider.addEventListener("input", () => {
    if (s.playing) actions.setPlaying(false);
    actions.setYear(Number(slider.value));
  });
  $("speed").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-fps]");
    if (!b) return;
    for (const x of $("speed").children) x.classList.toggle("is-active", x === b);
    actions.update({ fps: Number(b.dataset.fps) }, { redraw: false });
  });

  const grid = $("cmap-grid");
  const toggleGrid = () => (grid.hidden = !grid.hidden);
  $("ramp").addEventListener("click", toggleGrid);
  $("ramp-btn").addEventListener("click", toggleGrid);
  grid.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cmap]");
    if (!b) return;
    actions.update({ cmap: b.dataset.cmap as ColormapName });
  });
  $("rev").addEventListener("click", () => actions.update({ reversed: !s.reversed }));
  $("auto").addEventListener("click", () =>
    actions.update({
      vmin: s.variable.range.p2 ?? s.variable.range.min ?? 0,
      vmax: s.variable.range.p98 ?? s.variable.range.max ?? 1,
    }),
  );
  const vmin = $<HTMLInputElement>("vmin");
  const vmax = $<HTMLInputElement>("vmax");
  vmin.addEventListener("change", () => actions.update({ vmin: parseNum(vmin, s.vmin) }));
  vmax.addEventListener("change", () => actions.update({ vmax: parseNum(vmax, s.vmax) }));
  const opacity = $<HTMLInputElement>("opacity");
  opacity.addEventListener("input", () => actions.update({ opacity: Number(opacity.value) }));
  $("ins-close").addEventListener("click", () => actions.clearPin());

  window.addEventListener("keydown", (e) => {
    const typing = (e.target as HTMLElement).matches("input, textarea");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      q.focus();
    } else if (e.key === "Escape") {
      if (typing) (e.target as HTMLElement).blur();
      grid.hidden = true;
    } else if (typing) {
      return;
    } else if (e.key === " ") {
      e.preventDefault();
      actions.setPlaying(!s.playing);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (s.playing) actions.setPlaying(false);
      actions.setYear(s.yearIdx + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1));
    }
  });
  renderList(s);
}
