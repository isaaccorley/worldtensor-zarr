/**
 * Collapse 757 catalog variables into ~349 families with facets, so the UI
 * lists families and switches statistic / depth / land-use transition with
 * controls instead of scrolling every combination.
 *
 *   climate/t2m_mean                         -> climate/t2m          {stat: mean}
 *   static/soil_properties/bdod_0-5cm_mean   -> .../bdod             {depth: 0-5cm, stat: mean}
 *   land_use/transitions/c3ann_to_urban      -> land_use/transitions {from: c3ann, to: urban}
 */
import type { Catalog, Variable } from "./catalog.js";

export type FacetDim = "stat" | "depth" | "from" | "to";
export const FACET_ORDER: FacetDim[] = ["from", "to", "depth", "stat"];
export type Facets = Partial<Record<FacetDim, string>>;

export type Family = {
  key: string;
  domain: string;
  /** subgroup inside the domain ("soil_properties"), or "" */
  group: string;
  label: string;
  variants: { facets: Facets; variable: Variable }[];
  /** values available per facet dim, in display order */
  dims: Partial<Record<FacetDim, string[]>>;
};

const STAT_ORDER = ["mean", "min", "max", "std", "sum", "total"];

/** Display-only American spelling for source labels (store attrs untouched). */
export function americanize(s: string): string {
  return s
    .replace(/metre/g, "meter")
    .replace(/Metre/g, "Meter")
    .replace(/ulphur/g, "ulfur")
    .replace(/harmonis/g, "harmoniz")
    .replace(/colour/g, "color")
    .replace(/centre/g, "center");
}

/** LUH2 land-use state codes. */
export const LUH2: Record<string, string> = {
  primf: "Primary forest",
  primn: "Primary non-forest",
  secdf: "Secondary forest",
  secdn: "Secondary non-forest",
  urban: "Urban",
  c3ann: "C3 annual crops",
  c4ann: "C4 annual crops",
  c3per: "C3 perennial crops",
  c4per: "C4 perennial crops",
  c3nfx: "C3 nitrogen-fixing crops",
  pastr: "Managed pasture",
  range: "Rangeland",
  secma: "Secondary mean age",
  secmb: "Secondary mean biomass",
};

export function facetLabel(dim: FacetDim, value: string): string {
  if (dim === "from" || dim === "to") return LUH2[value] ?? value;
  if (dim === "depth") return value.replace("cm", " cm");
  return value;
}

function parse(v: Variable): { key: string; facets: Facets } {
  let p = v.path;
  const facets: Facets = {};
  let m = /_(mean|min|max|std|sum|total)$/.exec(p);
  if (m) {
    facets.stat = m[1]!;
    p = p.slice(0, m.index);
  }
  m = /_(\d+-\d+cm)/.exec(p);
  if (m) {
    facets.depth = m[1]!;
    p = p.slice(0, m.index) + p.slice(m.index + m[0].length);
  }
  m = /^(land_use\/transitions)\/(.+)_to_(.+)$/.exec(p);
  if (m) {
    facets.from = m[2]!;
    facets.to = m[3]!;
    p = m[1]!;
  }
  return { key: p, facets };
}

function familyLabel(key: string, sample: Variable): string {
  if (key === "land_use/transitions") return "Land-use transitions";
  const raw = sample.long_name?.trim();
  // identifier-like long names ("area_fraction") are not labels
  if (raw && !(/_/.test(raw) && !/\s/.test(raw) && raw.toLowerCase() === raw)) {
    const text = americanize(/\s/.test(raw) ? raw : raw.replaceAll("_", " "))
      .replace(/\s*\((mean|min|max|std|sum|total|minimum|maximum|standard deviation)\)\s*$/i, "")
      .replace(/\s*\(?\b\d+\s*-\s*\d+\s*cm\b\)?/gi, "")
      .replace(/\(\s*\)/g, "")
      .replace(/\s+(mean|total)$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return sentenceCase(text);
  }
  const leaf = key.split("/").pop()!;
  if (LUH2[leaf]) return LUH2[leaf]!;
  const t = leaf.replaceAll("_", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function sentenceCase(t: string): string {
  // "Liquid Water Equivalent Thickness" (from an identifier) -> "Liquid water equivalent thickness"
  const words = t.split(" ");
  const titled = words.length > 2 && words.every((w) => /^[A-Z][a-z]+$/.test(w));
  const out = titled ? words.map((w, i) => (i ? w.toLowerCase() : w)).join(" ") : t;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function sortValues(dim: FacetDim, vals: string[]): string[] {
  if (dim === "stat") return vals.sort((a, b) => STAT_ORDER.indexOf(a) - STAT_ORDER.indexOf(b));
  if (dim === "depth") return vals.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  return vals.sort((a, b) => facetLabel(dim, a).localeCompare(facetLabel(dim, b)));
}

export type FamilyIndex = {
  families: Family[];
  byKey: Map<string, Family>;
  ofVariable: Map<string, { family: Family; facets: Facets }>;
};

export function buildFamilies(catalog: Catalog): FamilyIndex {
  const byKey = new Map<string, Family>();
  const ofVariable = new Map<string, { family: Family; facets: Facets }>();
  for (const v of catalog.variables) {
    const { key, facets } = parse(v);
    let fam = byKey.get(key);
    if (!fam) {
      const parts = key.split("/");
      fam = {
        key,
        domain: v.domain,
        group: parts.length > 2 ? parts[1]! : "",
        label: "",
        variants: [],
        dims: {},
      };
      byKey.set(key, fam);
    }
    fam.variants.push({ facets, variable: v });
    ofVariable.set(v.path, { family: fam, facets });
  }
  for (const fam of byKey.values()) {
    const pref = fam.variants.find((x) => x.facets.stat === "mean") ?? fam.variants[0]!;
    fam.label = familyLabel(fam.key, pref.variable);
    for (const dim of FACET_ORDER) {
      const vals = [...new Set(fam.variants.map((x) => x.facets[dim]).filter((x): x is string => !!x))];
      if (vals.length) fam.dims[dim] = sortValues(dim, vals);
    }
  }
  const families = [...byKey.values()].sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
  );
  return { families, byKey, ofVariable };
}

/** Variant of `fam` best matching `want` (exact first, then most facets shared). */
export function pickVariant(fam: Family, want: Facets): Variable {
  let best = fam.variants[0]!;
  let score = -1;
  for (const x of fam.variants) {
    let s = 0;
    for (const dim of FACET_ORDER) if (want[dim] && x.facets[dim] === want[dim]) s += dim === "stat" ? 1 : 2;
    if (s > score) {
      score = s;
      best = x;
    }
  }
  return best.variable;
}

/** Preferred variant when opening a family fresh: mean, shallowest depth. */
export function defaultVariant(fam: Family): Variable {
  return pickVariant(fam, { stat: fam.dims.stat?.includes("mean") ? "mean" : fam.dims.stat?.[0], depth: fam.dims.depth?.[0] });
}

/** Facet values reachable from `current` when changing `dim` (keeps others fixed). */
export function available(fam: Family, current: Facets, dim: FacetDim): Set<string> {
  const out = new Set<string>();
  for (const x of fam.variants) {
    const ok = FACET_ORDER.every((d) => d === dim || !current[d] || x.facets[d] === current[d]);
    if (ok && x.facets[dim]) out.add(x.facets[dim]!);
  }
  return out;
}
