"""Compare current vs proposed layout on viewer access patterns using real
on-disk object sizes. Writes a small proposed-layout prototype store.

Patterns (per variable):
  A. first paint     : open variable, show latest year at coarsest useful level
  B. full-res view   : latest year at base resolution
  C. scrub years     : every year at 4x (animation / time slider)
  D. pixel series    : all years at one base pixel (click -> chart)
Latency model: RTT=100ms per serial round, 6 parallel conns, 50 Mbit/s.
"""
import json
import math
import os
import shutil

import numpy as np
import xarray as xr
import zarr
from zarr.codecs import BloscCodec, BloscShuffle

SRC = "/projects/bjey/worldtensor/zarr/worldtensor.zarr"
DST = "/projects/bjey/worldtensor/bench/proposed.zarr"
VARS = [
    "climate/t2m_mean",
    "climate/tp_sum",
    "ocean/chl_max",
    "land_use/states/secdf",
    "human_systems/ghsl_built_surface",
    "static/soil_properties/bdod_0-5cm_mean",
]
RTT, BW, PAR = 0.100, 50e6 / 8, 6
TS_TILE = 32


def bitround(a, keepbits=12):
    b = a.view(np.uint32)
    drop = 23 - keepbits
    out = ((b + np.uint32(1 << (drop - 1))) & np.uint32((0xFFFFFFFF >> drop) << drop)).view(np.float32)
    return np.where(np.isfinite(a), out, np.nan).astype(np.float32)


def est(rounds, sizes):
    """rounds of serial metadata hops, then sizes fetched PAR at a time."""
    waves = math.ceil(len(sizes) / PAR) if sizes else 0
    return (rounds + waves) * RTT + sum(sizes) / BW


def chunk_files(root, arr, sel):
    """sizes of chunk objects of array `arr` under group root intersecting sel
    (dict dim->(start, stop))."""
    meta = json.load(open(f"{root}/{arr}/zarr.json"))
    shape, cs = meta["shape"], meta["chunk_grid"]["configuration"]["chunk_shape"]
    dims = meta["dimension_names"]
    ranges = []
    for d, n, c in zip(dims, shape, cs):
        s, e = sel.get(d, (0, n))
        ranges.append(range(s // c, (e - 1) // c + 1))
    import itertools
    sizes = []
    for idx in itertools.product(*ranges):
        p = f"{root}/{arr}/c/" + "/".join(map(str, idx))
        if os.path.exists(p):
            sizes.append(os.path.getsize(p))
    return sizes


def write_proposed(g):
    ds = xr.open_zarr(SRC, group=g, consolidated=False)
    (v,) = [k for k in ds.data_vars if k != "spatial_ref"]
    has_t = "time" in ds[v].dims
    codec = BloscCodec(cname="zstd", clevel=5, shuffle=BloscShuffle.shuffle, typesize=4)
    levels = [(".", g)] + [(f"{f}x", f"{g}/{f}x") for f in (2, 4, 8, 16)]
    for name, path in levels:
        lds = xr.open_zarr(SRC, group=path, consolidated=False)
        da = lds[v].load()
        da.values[:] = bitround(da.values)
        out = da.to_dataset()
        ny, nx = da.sizes["lat"], da.sizes["lon"]
        chunks = (1, ny, nx) if has_t else (ny, nx)
        enc = {v: {"chunks": chunks, "compressors": [codec], "_FillValue": np.float32(np.nan)}}
        if has_t and name == ".":
            # time-series-optimized companion array: all years in one chunk
            out["ts"] = da.chunk({"time": -1, "lat": TS_TILE, "lon": TS_TILE})
            enc["ts"] = {"chunks": (da.sizes["time"], TS_TILE, TS_TILE),
                         "compressors": [codec], "_FillValue": np.float32(np.nan)}
        for c in out.variables:
            out[c].encoding = {}
        out.to_zarr(DST, group=path, mode="w", zarr_format=3, encoding=enc, consolidated=False)
    return v, has_t


def patterns(root, g, v, has_t, layout):
    def a(level):
        return (v if level == "." else f"{level}/{v}")
    meta = json.load(open(f"{root}/{g}/{v}/zarr.json"))
    T = meta["shape"][0] if has_t else 1
    last = {"time": (T - 1, T)} if has_t else {}
    if layout == "current":
        # client must open group + array (+coords) per level before data;
        # or pull the 24MB root consolidated zarr.json
        mrounds = 2
        A = est(mrounds, chunk_files(f"{root}/{g}", a("16x"), last))
        B = est(mrounds, chunk_files(f"{root}/{g}", a("."), last))
        C = est(mrounds, chunk_files(f"{root}/{g}", a("4x"), {})) if has_t else 0
        D = est(mrounds, chunk_files(f"{root}/{g}", a("."), {"lat": (360, 361), "lon": (700, 701)})) if has_t else 0
        Dbytes = sum(chunk_files(f"{root}/{g}", a("."), {"lat": (360, 361), "lon": (700, 701)})) if has_t else 0
    else:
        # metadata comes from one small catalog.json loaded at app start
        mrounds = 0
        A = est(mrounds, chunk_files(f"{root}/{g}", a("4x"), last))
        B = est(mrounds, chunk_files(f"{root}/{g}", a("."), last))
        C = est(mrounds, chunk_files(f"{root}/{g}", a("4x"), {})) if has_t else 0
        D = est(mrounds, chunk_files(f"{root}/{g}", "ts", {"lat": (360, 361), "lon": (700, 701)})) if has_t else 0
        Dbytes = sum(chunk_files(f"{root}/{g}", "ts", {"lat": (360, 361), "lon": (700, 701)})) if has_t else 0
    Bb = sum(chunk_files(f"{root}/{g}", a("."), last))
    Cb = sum(chunk_files(f"{root}/{g}", a("4x"), {})) if has_t else 0
    return A, B, Bb, C, Cb, D, Dbytes


def main():
    if os.path.exists(DST):
        shutil.rmtree(DST)
    zarr.open_group(DST, mode="w", zarr_format=3)
    print(f"{'variable':42s} {'layout':8s} {'A first':>8s} {'B base':>14s} {'C scrub@4x':>16s} {'D pixel series':>16s}")
    for g in VARS:
        v, has_t = write_proposed(g)
        for layout, root in (("current", SRC), ("proposed", DST)):
            A, B, Bb, C, Cb, D, Db = patterns(root, g, v, has_t, layout)
            print(f"{g:42s} {layout:8s} {A*1e3:6.0f}ms {B*1e3:6.0f}ms/{Bb/1e6:5.2f}MB "
                  f"{C*1e3:7.0f}ms/{Cb/1e6:5.1f}MB {D*1e3:7.0f}ms/{Db/1e6:5.2f}MB")
    cur = sum(os.path.getsize(os.path.join(dp, f)) for g in VARS for dp, _, fs in os.walk(f"{SRC}/{g}") for f in fs)
    new = sum(os.path.getsize(os.path.join(dp, f)) for g in VARS for dp, _, fs in os.walk(f"{DST}/{g}") for f in fs)
    print(f"\nstorage for these {len(VARS)} vars: current {cur/1e6:.0f}MB  proposed {new/1e6:.0f}MB (incl ts copy)")


if __name__ == "__main__":
    main()
