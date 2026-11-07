#!/usr/bin/env python3
"""Add a multiscale pyramid (halving, cascaded) plus a pixel-time-series
companion array to one variable group of the central worldtensor store.

Resampling is chosen from the variable's semantics:
  - integer dtype -> mode (categorical)
  - otherwise     -> average (every variable here is intensive: a mean,
                     rate, density, fraction, or a *temporal* sum per cell)

Survey of the source NetCDFs found every variable on disk is float32, nodata as
NaN, no scale/offset, and no true categorical class-id raster (e.g.
"vegetation_class" is actually 18 separate float32 fractional presence masks,
one per class, not a single integer label array) - so name-sniffing for
"class" is deliberately NOT used here, only dtype.

Chunk layout (tuned for a browser reading over HTTPS range requests):
  - base            : one year per chunk, 2x4 spatial tiles (set in 04_convert)
  - 2x              : one year per chunk, whole globe -> global view = 1 request
  - 4x and coarser  : all years per chunk -> one request loads the time slider
  - <group>/ts      : base res, (all years, 16, 16) inner chunks in a single
                      shard -> one small range request per clicked pixel

Usage: 05_multiscale.py <manifest.jsonl> <line_index> [--ts-only]
  --ts-only rewrites just the <group>/ts array (pyramid untouched)
"""
import json
import os
import sys

import numpy as np
import xarray as xr
from scipy import stats
from zarr.codecs import BloscCodec, BloscShuffle

STORE = os.environ.get("WT_STORE", "/projects/bjey/worldtensor/zarr/worldtensor.zarr")
MIN_DIM = 90  # stop pyramid once the coarsest side is roughly tile-sized
TS_TILE = 16  # 16x16 px tiles: ~40 KB per pixel-history read (lossless)


def compressor():
    # keep in sync with 04_convert.py (scripts run with -I, no shared module)
    return BloscCodec(cname="zstd", clevel=9, shuffle=BloscShuffle.shuffle, typesize=4)


def resampling_method(varname: str, dtype) -> str:
    # NOT sum pooling for "*_sum": in WorldTensor that suffix is a *temporal*
    # aggregate (annual total), and the values are intensive (depth, rate,
    # density), so spatial pooling must average. Summing scaled every level
    # by 4/16/64. Averaging also keeps colours consistent across zoom levels.
    if np.issubdtype(dtype, np.integer):
        return "mode"
    return "average"


def mode_reduce(block, axis):
    m, _ = stats.mode(block, axis=axis, nan_policy="omit", keepdims=False)
    return m


def coarsen_once(da: xr.DataArray, method: str) -> xr.DataArray:
    # trim, not pad: the 721-row grid includes both poles, so padding gives
    # the last coarse row a centre of 90.0 that no affine transform matches.
    # Trimming drops the odd 90N row from overviews only (base keeps it) and
    # keeps every level exactly affine with coords inside +-90.
    c = da.coarsen(boundary="trim", lat=2, lon=2)
    if method == "sum":
        return c.sum()
    if method == "mode":
        return c.reduce(mode_reduce)
    return c.mean()


def level_chunks(da: xr.DataArray, factor: int):
    ny, nx = da.sizes["lat"], da.sizes["lon"]
    if "time" not in da.dims:
        return (ny, nx)
    nt = da.sizes["time"] if factor >= 4 else 1
    return (nt, ny, nx)


def write_level(da, varname, attrs, spatial_ref, path, encoding_extra):
    ds = da.to_dataset(name=varname)
    ds["spatial_ref"] = spatial_ref
    ds[varname].attrs = attrs
    for v in ds.variables:
        ds[v].encoding = {}
    enc = {varname: {"_FillValue": np.float32(np.nan), "compressors": [compressor()], **encoding_extra}}
    ds.to_zarr(STORE, group=path, mode="w", zarr_format=3, encoding=enc, consolidated=False)


def write_ts(base, varname, attrs, spatial_ref, group_path):
    nt, ny, nx = base.sizes["time"], base.sizes["lat"], base.sizes["lon"]
    ceil = lambda n: -(-n // TS_TILE) * TS_TILE  # noqa: E731
    write_level(base, varname, attrs, spatial_ref, f"{group_path}/ts",
                {"chunks": (nt, TS_TILE, TS_TILE), "shards": (nt, ceil(ny), ceil(nx))})


def main():
    manifest_path, idx = sys.argv[1], int(sys.argv[2])
    with open(manifest_path) as fh:
        unit = json.loads(fh.readlines()[idx])

    ts_only = "--ts-only" in sys.argv[3:]
    group_path = unit["group_path"]
    root = xr.open_zarr(STORE, group=group_path, consolidated=False)
    (varname,) = [v for v in root.data_vars if v != "spatial_ref"]
    if ts_only and "time" not in root[varname].dims:
        print(f"{group_path}: static, no ts array", file=sys.stderr)
        return
    base = root[varname].load()
    method = resampling_method(varname, base.dtype)
    attrs = dict(base.attrs, resampling_method=method)
    spatial_ref = root["spatial_ref"].load()
    if ts_only:
        write_ts(base, varname, attrs, spatial_ref, group_path)
        print(f"{group_path}: rewrote ts with {TS_TILE}x{TS_TILE} tiles", file=sys.stderr)
        return

    levels = ["."]
    factor, current = 2, base
    while min(current.sizes["lat"], current.sizes["lon"]) > MIN_DIM:
        current = coarsen_once(current, method).astype("float32")
        name = f"{factor}x"
        write_level(current, varname, attrs, spatial_ref, f"{group_path}/{name}",
                    {"chunks": level_chunks(current, factor)})
        levels.append(name)
        factor *= 2

    if "time" in base.dims:
        write_ts(base, varname, attrs, spatial_ref, group_path)

    # drop level groups left over from a deeper earlier build (e.g. a 16x that
    # trim halving no longer reaches)
    import zarr

    grp = zarr.open_group(STORE, path=group_path, mode="r+", use_consolidated=False)
    for name, _ in list(grp.groups()):
        if name.endswith("x") and name[:-1].isdigit() and name not in levels:
            del grp[name]
            print(f"{group_path}: removed stale level {name}", file=sys.stderr)

    # multiscales / proj / spatial attrs are written by 10_geozarr.py
    print(f"{group_path}: built {len(levels) - 1} pyramid levels using {method}", file=sys.stderr)


if __name__ == "__main__":
    main()
