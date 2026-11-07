import * as zarr from "zarrita";
import type { Catalog, Variable } from "./catalog.js";
import { arrayPath } from "./catalog.js";

/** Grid cell (row, col) at a level of the given factor, or null off-grid. */
export function cellAt(catalog: Catalog, lng: number, lat: number, factor = 1) {
  const { resolution, lat_first, lon_first, shape } = catalog.grid;
  const res = resolution * factor;
  const off = ((factor - 1) * resolution) / 2;
  const lon360 = (((lng - lon_first) % 360) + 360) % 360;
  // overview levels halve with the odd trailing row trimmed
  const ny = Math.floor(shape[0] / factor);
  const nx = Math.floor(shape[1] / factor);
  const row = Math.round((lat - lat_first - off) / res);
  const col = Math.round((lon360 - off) / res) % nx;
  if (row < 0 || row >= ny) return null;
  return { row, col, ny, nx };
}

/**
 * Hover readout as a point query. Paused: the exact base-resolution pixel of
 * the shown year, from chunks the detail layer has already cached. Playing:
 * the 8x overview chunk (all years, also cached). Either way the store
 * serves bytes from memory, so a query is one chunk decode (~1 ms).
 */
export class Probe {
  private arrays = new Map<string, Promise<zarr.Array<zarr.DataType, zarr.Readable>>>();
  private token = 0;
  constructor(
    private store: zarr.Readable,
    private catalog: Catalog,
    readonly variable: Variable,
  ) {}

  private array(level: string) {
    let p = this.arrays.get(level);
    if (!p) {
      p = zarr.open(zarr.root(this.store).resolve(arrayPath(this.variable, level)), { kind: "array" });
      this.arrays.set(level, p);
    }
    return p;
  }

  /** Resolves null when superseded by a newer query, off-grid, or nodata. */
  async valueAt(lng: number, lat: number, yearIdx: number, coarse: boolean): Promise<number | null> {
    const token = ++this.token;
    const level = coarse && "8x" in this.variable.arrays ? "8x" : ".";
    const cell = cellAt(this.catalog, lng, lat, level === "8x" ? 8 : 1);
    if (!cell) return null;
    const arr = await this.array(level);
    const sel = arr.shape.length === 3 ? [yearIdx, cell.row, cell.col] : [cell.row, cell.col];
    const v = (await zarr.get(arr, sel)) as number;
    if (token !== this.token) return null;
    return Number.isNaN(v) ? null : v;
  }
}

const tsArrays = new Map<string, Promise<zarr.Array<zarr.DataType, zarr.Readable>>>();

/** Full-resolution time series at one pixel from the sharded `ts` array. */
export async function readSeries(
  store: zarr.Readable,
  catalog: Catalog,
  v: Variable,
  lng: number,
  lat: number,
): Promise<Float32Array | null> {
  if (!v.arrays.ts) return null;
  const cell = cellAt(catalog, lng, lat);
  if (!cell) return null;
  // keep one opened array per variable: zarrita caches the shard index on the
  // array instance, so reopening would refetch the (~66 KB) index every click
  let pending = tsArrays.get(v.path);
  if (!pending) {
    pending = zarr.open(zarr.root(store).resolve(`${v.path}/ts/${v.name}`), { kind: "array" });
    tsArrays.set(v.path, pending);
  }
  const arr = await pending;
  if (!arr.is("float32")) return null;
  const out = await zarr.get(arr, [null, cell.row, cell.col]);
  return out.data;
}
