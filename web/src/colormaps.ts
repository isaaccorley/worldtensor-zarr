import { COLORMAP_INDEX, decodeColormapSprite } from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import type { Variable } from "./catalog.js";

export type ColormapName = keyof typeof COLORMAP_INDEX;

/** Curated picker order: perceptually uniform first, then diverging. */
export const PICKER: ColormapName[] = [
  "thermal", "viridis", "magma", "inferno", "cividis", "turbo",
  "haline", "deep", "ice", "dense", "tempo", "algae",
  "speed", "matter", "amp", "solar", "gist_earth", "terrain",
  "balance", "rdbu", "coolwarm", "curl", "brbg", "piyg",
];

const DOMAIN_DEFAULT: Record<string, ColormapName> = {
  climate: "thermal",
  ocean: "haline",
  vegetation: "algae",
  agriculture: "speed",
  land_use: "speed",
  hydrology: "dense",
  cryosphere: "ice",
  human_systems: "inferno",
  emissions: "inferno",
  air_quality: "matter",
  extremes: "amp",
  hazards_and_conflict: "amp",
  energy: "solar",
  static: "gist_earth",
};

export function defaultColormap(v: Variable): { name: ColormapName; reversed: boolean } {
  const n = v.name.toLowerCase();
  if (/^(tp|cp|lsp|e|ro|sro|ssro|sf|csf|lsf)_|precip|runoff|rain/.test(n)) {
    return { name: "dense", reversed: false };
  }
  if (/(^t2m|^d2m|^skt|^sst|^stl|temp)/.test(n)) return { name: "thermal", reversed: false };
  if (/_std$/.test(n)) return { name: "magma", reversed: false };
  return { name: DOMAIN_DEFAULT[v.domain] ?? "viridis", reversed: false };
}

export async function loadSprite(): Promise<ImageData> {
  const bytes = await (await fetch(colormapsPngUrl)).arrayBuffer();
  return decodeColormapSprite(bytes);
}

const swatchCache = new Map<string, string>();

/** A 256x1 PNG data URL of one sprite row, for CSS backgrounds. */
export function swatchUrl(sprite: ImageData, name: ColormapName, reversed = false): string {
  const key = `${name}:${reversed}`;
  const hit = swatchCache.get(key);
  if (hit) return hit;
  const row = COLORMAP_INDEX[name];
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(256, 1);
  for (let i = 0; i < 256; i++) {
    const src = (row * 256 + (reversed ? 255 - i : i)) * 4;
    img.data.set(sprite.data.subarray(src, src + 4), i * 4);
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  swatchCache.set(key, url);
  return url;
}

export { COLORMAP_INDEX };
