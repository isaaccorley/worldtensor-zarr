import type { AbsolutePath, AsyncReadable, RangeQuery } from "@zarrita/storage";
import * as zarr from "zarrita";
import type { Catalog, Variable } from "./catalog.js";
import { levelsOf } from "./catalog.js";

const encoder = new TextEncoder();
const MAX_CACHE_BYTES = 384 * 1024 * 1024;

/**
 * zarrita store over HTTP tuned for the viewer:
 *  - answers `zarr.json` for every pyramid group/array straight from the
 *    catalog, so opening a variable costs zero metadata round trips
 *  - dedupes in-flight requests and keeps an LRU of chunk bytes, so the
 *    hover readout, revisited years and re-zooms never hit the network twice
 *  - reports pending request count for the status LED
 */
export class ViewerStore implements AsyncReadable {
  private inner: zarr.FetchStore;
  private groups = new Map<string, Variable>();
  private cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;
  private inflight = new Map<string, Promise<Uint8Array | undefined>>();
  private pending = 0;
  onActivity: (pending: number) => void = () => {};

  constructor(
    url: string,
    private catalog: Catalog,
  ) {
    this.inner = new zarr.FetchStore(url);
    for (const v of catalog.variables) this.groups.set(v.path, v);
  }

  async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
    if (key.endsWith("/zarr.json")) {
      const synth = this.synthesize(key.slice(1, -"/zarr.json".length));
      if (synth) return synth;
    }
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return hit;
    }
    // not passing the tile's abort signal: a deduped request may be shared by
    // several consumers, and finishing it warms the cache anyway
    return this.track(key, () => this.inner.get(key));
  }

  getRange(key: AbsolutePath, range: RangeQuery): Promise<Uint8Array | undefined> {
    const id = `${key}#${JSON.stringify(range)}`;
    const hit = this.cache.get(id);
    if (hit) return Promise.resolve(hit);
    return this.track(id, () => this.inner.getRange(key, range));
  }

  private track(id: string, fetcher: () => Promise<Uint8Array | undefined>) {
    const existing = this.inflight.get(id);
    if (existing) return existing;
    this.onActivity(++this.pending);
    const p = fetcher()
      .then((bytes) => {
        if (bytes) this.remember(id, bytes);
        return bytes;
      })
      .finally(() => {
        this.inflight.delete(id);
        this.onActivity(--this.pending);
      });
    this.inflight.set(id, p);
    return p;
  }

  private remember(id: string, bytes: Uint8Array) {
    this.cache.set(id, bytes);
    this.cacheBytes += bytes.byteLength;
    for (const [k, b] of this.cache) {
      if (this.cacheBytes <= MAX_CACHE_BYTES) break;
      this.cache.delete(k);
      this.cacheBytes -= b.byteLength;
    }
  }

  /** Metadata for a variable group, a level group, or a level array. */
  private synthesize(path: string): Uint8Array | undefined {
    const parts = path.split("/");
    for (let i = parts.length; i > 0; i--) {
      const v = this.groups.get(parts.slice(0, i).join("/"));
      if (!v) continue;
      const rest = parts.slice(i);
      if (rest.length === 0) return json(groupMeta());
      // "ts" is sharded; let the real zarr.json through
      if (rest[0] === "ts") return undefined;
      const levels = levelsOf(v);
      if (rest.length === 1 && rest[0] === v.name) return json(this.arrayMeta(v, "."));
      if (rest.length === 1 && levels.includes(rest[0]!)) return json(groupMeta());
      if (rest.length === 2 && levels.includes(rest[0]!) && rest[1] === v.name) {
        return json(this.arrayMeta(v, rest[0]!));
      }
      return undefined;
    }
    return undefined;
  }

  private arrayMeta(v: Variable, level: string) {
    const info = v.arrays[level]!;
    const t = this.catalog.array_template;
    return {
      zarr_format: 3,
      node_type: "array",
      shape: info.shape,
      data_type: t.data_type,
      chunk_grid: { name: "regular", configuration: { chunk_shape: info.chunk_shape } },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: t.fill_value,
      codecs: t.codecs,
      attributes: {},
      dimension_names: info.shape.length === 3 ? ["time", "lat", "lon"] : ["lat", "lon"],
    };
  }
}

function groupMeta() {
  return { zarr_format: 3, node_type: "group", attributes: {} };
}

function json(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj));
}
