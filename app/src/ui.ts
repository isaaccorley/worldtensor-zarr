import type { Variable } from "./catalog.js";
import { DOMAIN_LABELS } from "./catalog.js";
import type { ColormapName } from "./colormaps.js";
import { PICKER, QUICK, swatchUrl } from "./colormaps.js";
import type { Facets, FamilyIndex, FacetDim } from "./facets.js";
import { available, buildFamilies, defaultVariant, facetLabel, FACET_ORDER, pickVariant } from "./facets.js";
import { fmt, fmtLatLng, sparkline, trendPerDecade } from "./format.js";
import type { State } from "./main.js";
import { initPalette } from "./palette.js";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export type Actions = {
  selectVariable: (v: Variable) => void;
  setYear: (i: number) => void;
  setPlaying: (p: boolean) => void;
  update: (patch: Partial<State>, opts?: { redraw?: boolean }) => void;
  clearPin: () => void;
};

let actions: Actions;
let index: FamilyIndex;
let openDomain: string | null = null;
let navKey = "";
let lastFamKey = "";

const DIM_LABEL: Record<FacetDim, string> = { stat: "Statistic", depth: "Depth", from: "From", to: "To" };

function current(s: State) {
  return index.ofVariable.get(s.variable.path)!;
}

/** Display title for the selected variable: family label + facets. */
export function titleOf(s: State): string {
  const { family, facets } = current(s);
  if (facets.from && facets.to) return `${facetLabel("from", facets.from)} → ${facetLabel("to", facets.to)}`;
  return family.label;
}

// ---------- left: domain -> family tree ----------
export function renderList(s: State) {
  const fam = current(s).family;
  if (fam.key !== lastFamKey) {
    // follow the selection (e.g. picked from the palette in another domain)
    lastFamKey = fam.key;
    openDomain = fam.domain;
  }
  const key = `${openDomain}|${fam.key}`;
  if (key === navKey) return;
  navKey = key;
  const domains = new Map<string, number>();
  for (const f of index.families) domains.set(f.domain, (domains.get(f.domain) ?? 0) + 1);
  let html = `<div class="label" style="padding:4px 16px 6px">Domains</div>`;
  for (const [d, n] of [...domains].sort((a, b) => a[0].localeCompare(b[0]))) {
    const open = d === openDomain;
    html += `<button class="dom${open ? " is-open" : ""}" data-domain="${d}"><span>${DOMAIN_LABELS[d] ?? d}</span><span class="n">${n}</span></button>`;
    if (!open) continue;
    html += `<div class="fams">`;
    let group = "";
    for (const f of index.families.filter((x) => x.domain === d)) {
      if (f.group !== group) {
        group = f.group;
        html += `<div class="grp">${group.replaceAll("_", " ")}</div>`;
      }
      const n = f.variants.length > 1 ? `<span class="n">${f.variants.length}</span>` : "";
      html += `<button class="fam${f.key === fam.key ? " is-active" : ""}" data-fam="${f.key}"><span>${f.label}</span>${n}</button>`;
    }
    html += `</div>`;
  }
  $("nav").innerHTML = html;
  $("nav").querySelector(".fam.is-active")?.scrollIntoView({ block: "nearest" });
}

// ---------- right: selection + facets ----------
function renderSelection(s: State) {
  const { family, facets } = current(s);
  const v = s.variable;
  $("var-title").textContent = titleOf(s);
  $("var-sub").textContent = `${v.path}${v.units ? `  ·  ${v.units}` : ""}`;
  $("crumb").textContent = `${(DOMAIN_LABELS[v.domain] ?? v.domain).toLowerCase()} / ${family.label}`;
  const cap = $("cap-big");
  if (cap.dataset.key !== v.path) {
    cap.dataset.key = v.path;
    cap.textContent = titleOf(s);
    // restart the rise animation on each new variable
    cap.style.animation = "none";
    void cap.offsetWidth;
    cap.style.animation = "";
    const facetBits = FACET_ORDER.filter((d) => facets[d]).map((d) => facetLabel(d, facets[d]!));
    const span = s.years.length > 1 ? `${s.years[0]}–${s.years[s.years.length - 1]}` : "static";
    $("cap-kick").textContent = [DOMAIN_LABELS[v.domain] ?? v.domain, ...facetBits, span].join(" · ");
  }
  const box = $("facets");
  const key = `${v.path}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = FACET_ORDER.filter((d) => family.dims[d])
    .map((dim) => {
      const vals = family.dims[dim]!;
      const ok = available(family, facets, dim);
      if (dim === "from" || dim === "to") {
        const opts = vals
          .map((x) => `<option value="${x}"${x === facets[dim] ? " selected" : ""}${ok.has(x) ? "" : " disabled"}>${facetLabel(dim, x)}</option>`)
          .join("");
        return `<div class="facet"><div class="flabel">${DIM_LABEL[dim]}</div><select class="pick" data-dim="${dim}">${opts}</select></div>`;
      }
      if (vals.length < 2) return "";
      const chips = vals
        .map((x) => `<button class="chip${x === facets[dim] ? " is-active" : ""}" data-dim="${dim}" data-val="${x}"${ok.has(x) ? "" : " disabled"}>${facetLabel(dim, x)}</button>`)
        .join("");
      return `<div class="facet"><div class="flabel">${DIM_LABEL[dim]}</div><div class="chips">${chips}</div></div>`;
    })
    .join("");
}

function switchFacet(s: State, dim: FacetDim, val: string) {
  const { family, facets } = current(s);
  const want: Facets = { ...facets, [dim]: val };
  // a from->to pair that doesn't exist: keep the changed side, pick any partner
  if ((dim === "from" || dim === "to") && !family.variants.some((x) => x.facets.from === want.from && x.facets.to === want.to)) {
    const other = dim === "from" ? "to" : "from";
    want[other] = family.variants.find((x) => x.facets[dim] === val)?.facets[other];
  }
  actions.selectVariable(pickVariant(family, want));
}

// ---------- bottom: timeline ----------
export function renderTimeline(s: State) {
  renderSelection(s);
  const temporal = s.years.length > 1;
  $("timeline").classList.toggle("is-static", !temporal);
  $("timeline").classList.toggle("is-playing", s.playing);
  $("year").textContent = temporal ? String(s.years[s.yearIdx]) : "static";
  const slider = $<HTMLInputElement>("slider");
  slider.max = String(Math.max(0, s.years.length - 1));
  slider.value = String(s.yearIdx);
  slider.style.setProperty("--v", `${(s.yearIdx / Math.max(1, s.years.length - 1)) * 100}%`);
  const key = `${s.years[0]}-${s.years.length}`;
  if ($("ticks").dataset.key === key) return;
  $("ticks").dataset.key = key;
  const n = s.years.length;
  const at = (i: number) => (i / Math.max(1, n - 1)) * 100;
  const step = n > 90 ? 20 : n > 40 ? 10 : 5;
  $("ruler").innerHTML = s.years.map((y, i) => `<i class="${y % 10 === 0 ? "major" : ""}" style="left:${at(i)}%"></i>`).join("");
  $("ticks").innerHTML = s.years.map((y, i) => (y % step === 0 ? `<span style="left:${at(i)}%">${y}</span>` : "")).join("");
}

// ---------- right: color ----------
export function renderLegend(s: State) {
  $("ramp").style.backgroundImage = `url(${swatchUrl(s.sprite, s.cmap, s.reversed)})`;
  const vmin = $<HTMLInputElement>("vmin");
  const vmax = $<HTMLInputElement>("vmax");
  if (document.activeElement !== vmin) vmin.value = fmt(s.vmin);
  if (document.activeElement !== vmax) vmax.value = fmt(s.vmax);
  $("units").textContent = s.variable.units ? `· ${s.variable.units}` : "";
  $("rev").classList.toggle("is-active", s.reversed);
  $("cbar-ticks").innerHTML = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => `<span style="left:${t * 100}%">${fmt(s.vmin + t * (s.vmax - s.vmin))}</span>`)
    .join("");
  const grid = $("cmap-grid");
  if (!grid.dataset.ready) {
    grid.dataset.ready = "1";
    grid.innerHTML = PICKER.map(
      (n) => `<button class="swatch" data-cmap="${n}" title="${n}" style="background-image:url(${swatchUrl(s.sprite, n)})"><span>${n}</span></button>`,
    ).join("");
  }
  for (const b of grid.querySelectorAll<HTMLElement>(".swatch")) b.classList.toggle("is-active", b.dataset.cmap === s.cmap);
  const ramps = $("ramps");
  if (!ramps.dataset.ready) {
    ramps.dataset.ready = "1";
    ramps.innerHTML = QUICK.map(
      (n, i) => `<button data-cmap="${n}" title="${n} (${i + 1})" style="background-image:url(${swatchUrl(s.sprite, n)})"><i>${i + 1}</i></button>`,
    ).join("");
  }
  for (const b of ramps.querySelectorAll<HTMLElement>("button")) b.classList.toggle("is-active", b.dataset.cmap === s.cmap);
  $("cmap-name").textContent = s.cmap + (s.reversed ? " · reversed" : "");
}

// ---------- right: pixel inspector ----------
export function renderInspector(s: State) {
  $("ins-empty").hidden = !!s.pin;
  $("ins-body").hidden = !s.pin;
  $("ins-close").style.visibility = s.pin ? "visible" : "hidden";
  if (!s.pin) return;
  $("ins-coord").textContent = fmtLatLng(s.pin.lng, s.pin.lat);
  $("ins-units").textContent = s.variable.units ?? "";
  if (!s.variable.arrays.ts) {
    $("ins-now").textContent = "—";
    $("ins-trend").textContent = "static variable, no time axis";
    $("ins-chart").innerHTML = "";
    $("ins-y0").textContent = $("ins-y1").textContent = "";
    return;
  }
  const series = s.pin.series;
  if (!series) {
    $("ins-now").textContent = "…";
    $("ins-trend").textContent = "reading pixel history";
    $("ins-chart").innerHTML = `<div class="ts-loading"></div>`;
    return;
  }
  $("ins-now").textContent = fmt(series[s.yearIdx]);
  const tr = trendPerDecade(s.years, series);
  $("ins-trend").innerHTML =
    tr === null
      ? `${s.years[s.yearIdx]}`
      : `${s.years[s.yearIdx]} · trend <b class="${tr >= 0 ? "up" : "down"}">${tr >= 0 ? "+" : ""}${fmt(tr)}</b>/decade`;
  $("ins-chart").innerHTML = sparkline(s.years, series, s.yearIdx, 268, 96);
  $("ins-y0").textContent = String(s.years[0]);
  $("ins-y1").textContent = String(s.years[s.years.length - 1]);
}

function parseNum(el: HTMLInputElement, fallback: number) {
  const n = Number.parseFloat(el.value.replaceAll(",", ""));
  return Number.isFinite(n) ? n : fallback;
}

export function bindUi(s: State, a: Actions) {
  actions = a;
  index = buildFamilies(s.catalog);
  $("var-count").textContent = String(s.catalog.variables.length);
  const palette = initPalette(index, s.catalog.variables, (v) => actions.selectVariable(v));
  $("open-palette").addEventListener("click", () => palette.open());

  $("nav").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const dom = t.closest<HTMLElement>("[data-domain]");
    if (dom) {
      openDomain = openDomain === dom.dataset.domain ? null : dom.dataset.domain!;
      navKey = "";
      renderList(s);
      return;
    }
    const fam = t.closest<HTMLElement>("[data-fam]");
    const f = fam && index.byKey.get(fam.dataset.fam!);
    if (f) actions.selectVariable(defaultVariant(f));
  });
  $("facets").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-val]");
    if (b) switchFacet(s, b.dataset.dim as FacetDim, b.dataset.val!);
  });
  $("facets").addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.dataset.dim) switchFacet(s, sel.dataset.dim as FacetDim, sel.value);
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
  const pickCmap = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cmap]");
    if (b) actions.update({ cmap: b.dataset.cmap as ColormapName });
  };
  grid.addEventListener("click", pickCmap);
  $("ramps").addEventListener("click", pickCmap);
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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette.open();
      return;
    }
    if (palette.isOpen()) return;
    const typing = (e.target as HTMLElement).matches("input, textarea, select");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      palette.open();
    } else if (e.key === "Escape") {
      grid.hidden = true;
    } else if (typing) {
      return;
    } else if (e.key === " ") {
      e.preventDefault();
      actions.setPlaying(!s.playing);
    } else if (/^[1-6]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      actions.update({ cmap: QUICK[Number(e.key) - 1] });
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (s.playing) actions.setPlaying(false);
      actions.setYear(s.yearIdx + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1));
    }
  });
  renderList(s);
}
