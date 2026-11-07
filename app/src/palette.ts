/** ⌘K command palette: fuzzy-ish search over all 757 variables. */
import type { Variable } from "./catalog.js";
import { DOMAIN_LABELS } from "./catalog.js";
import type { FamilyIndex } from "./facets.js";
import { defaultVariant, FACET_ORDER, facetLabel } from "./facets.js";

const $ = (id: string) => document.getElementById(id)!;

type Entry = { v: Variable; title: string; hay: string };

function title(index: FamilyIndex, v: Variable): string {
  const hit = index.ofVariable.get(v.path)!;
  const parts = FACET_ORDER.filter((d) => hit.facets[d]).map((d) => facetLabel(d, hit.facets[d]!));
  if (hit.facets.from && hit.facets.to) {
    return `${hit.family.label}: ${facetLabel("from", hit.facets.from)} → ${facetLabel("to", hit.facets.to)}`;
  }
  return parts.length ? `${hit.family.label} · ${parts.join(" · ")}` : hit.family.label;
}

function score(e: Entry, terms: string[]): number {
  let s = 0;
  for (const t of terms) {
    const i = e.hay.indexOf(t);
    if (i < 0) return -1;
    s += i === 0 || e.hay[i - 1] === " " || e.hay[i - 1] === "/" ? 3 : 1;
  }
  return s - e.title.length / 200;
}

export function initPalette(index: FamilyIndex, variables: Variable[], onPick: (v: Variable) => void) {
  const entries: Entry[] = variables.map((v) => {
    const t = title(index, v);
    return { v, title: t, hay: `${t} ${v.path} ${DOMAIN_LABELS[v.domain] ?? v.domain} ${v.units ?? ""}`.toLowerCase() };
  });
  // empty query: one row per family (its default variant), in tree order
  const byPath = new Map(entries.map((e) => [e.v.path, e]));
  const familyDefaults = index.families.map((f) => byPath.get(defaultVariant(f).path)!);
  const root = $("palette");
  const input = $("palette-q") as HTMLInputElement;
  const list = $("palette-results");
  let results: Entry[] = [];
  let sel = 0;

  const draw = () => {
    if (!results.length) {
      list.innerHTML = `<li class="pr-empty">No matches</li>`;
      return;
    }
    list.innerHTML = results
      .map(
        (e, i) => `<li class="pr${i === sel ? " is-sel" : ""}" data-i="${i}">
          <span class="t">${e.title}</span><span class="d">${DOMAIN_LABELS[e.v.domain] ?? e.v.domain}</span>
          <span class="p">${e.v.path}${e.v.units ? ` · ${e.v.units}` : ""}</span></li>`,
      )
      .join("");
    list.querySelector(".is-sel")?.scrollIntoView({ block: "nearest" });
  };
  const search = () => {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    results = terms.length
      ? entries
          .map((e) => [e, score(e, terms)] as const)
          .filter(([, s]) => s >= 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 60)
          .map(([e]) => e)
      : familyDefaults;
    sel = 0;
    draw();
  };
  const close = () => {
    root.hidden = true;
  };
  const pick = (i: number) => {
    const e = results[i];
    if (!e) return;
    close();
    onPick(e.v);
  };

  input.addEventListener("input", search);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      sel = Math.max(0, Math.min(results.length - 1, sel + (ev.key === "ArrowDown" ? 1 : -1)));
      draw();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      pick(sel);
    } else if (ev.key === "Escape") {
      close();
    }
  });
  list.addEventListener("mousemove", (ev) => {
    const li = (ev.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (li && Number(li.dataset.i) !== sel) {
      sel = Number(li.dataset.i);
      draw();
    }
  });
  list.addEventListener("click", (ev) => {
    const li = (ev.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (li) pick(Number(li.dataset.i));
  });
  root.addEventListener("mousedown", (ev) => {
    if (ev.target === root) close();
  });

  return {
    open() {
      root.hidden = false;
      input.value = "";
      search();
      input.focus();
    },
    isOpen: () => !root.hidden,
  };
}
