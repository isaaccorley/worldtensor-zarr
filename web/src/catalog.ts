/** Types + helpers for `<store>/catalog.json` (written by pipeline/08_catalog.py). */

export type ArrayInfo = {
  shape: number[];
  chunk_shape: number[];
  shard_shape?: number[];
};

export type Variable = {
  path: string;
  name: string;
  domain: string;
  units: string | null;
  long_name: string | null;
  years: { start: number; end: number } | number[] | null;
  resampling: string;
  range: { p2: number | null; p98: number | null; min: number | null; max: number | null };
  /** keyed by level path (".", "2x", ...) plus "ts" */
  arrays: Record<string, ArrayInfo>;
};

export type Catalog = {
  version: number;
  grid: {
    shape: [number, number];
    lat_first: number;
    lon_first: number;
    resolution: number;
    lat_order: "ascending" | "descending";
  };
  array_template: { data_type: string; fill_value: unknown; codecs: unknown[] };
  variables: Variable[];
};

export async function loadCatalog(baseUrl: string): Promise<Catalog> {
  const resp = await fetch(`${baseUrl}/catalog.json`);
  if (!resp.ok) throw new Error(`catalog.json: HTTP ${resp.status}`);
  return resp.json();
}

export function yearsOf(v: Variable): number[] {
  if (!v.years) return [];
  if (Array.isArray(v.years)) return v.years;
  const out: number[] = [];
  for (let y = v.years.start; y <= v.years.end; y++) out.push(y);
  return out;
}

/** Pyramid level paths finest-first, e.g. [".", "2x", "4x", "8x", "16x"]. */
export function levelsOf(v: Variable): string[] {
  return Object.keys(v.arrays)
    .filter((k) => k !== "ts")
    .sort((a, b) => factorOf(a) - factorOf(b));
}

export function factorOf(level: string): number {
  return level === "." ? 1 : Number.parseInt(level, 10);
}

export function arrayPath(v: Variable, level: string): string {
  return level === "." ? `${v.path}/${v.name}` : `${v.path}/${level}/${v.name}`;
}

/** Human label: long_name if present, else a tidied variable name. */
export function labelOf(v: Variable): string {
  if (v.long_name) return v.long_name;
  return v.path.split("/").slice(1).join(" / ").replaceAll("_", " ");
}

export const DOMAIN_LABELS: Record<string, string> = {
  agriculture: "Agriculture",
  air_quality: "Air quality",
  climate: "Climate",
  cryosphere: "Cryosphere",
  emissions: "Emissions",
  energy: "Energy",
  extremes: "Extremes",
  hazards_and_conflict: "Hazards",
  human_systems: "Human",
  hydrology: "Hydrology",
  land_use: "Land use",
  ocean: "Ocean",
  static: "Static",
  vegetation: "Vegetation",
};
