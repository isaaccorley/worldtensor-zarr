#!/usr/bin/env python3
"""Add a multiscale pyramid (2x halving, cascaded) plus a pixel-time-series
companion array to one variable group of the central worldtensor store.

Every level is a spatial average. Survey of the source NetCDFs found every
variable on disk is float32, nodata as NaN, no scale/offset, and no true
categorical class-id raster (e.g. "vegetation_class" is actually 18 separate
float32 fractional presence masks, one per class), so there is no mode or
nearest-neighbour path.

Chunk layout (tuned for a browser reading over HTTPS range requests):
  - base            : one year per chunk, 2x4 spatial tiles (set in 04_convert)
  - 2x              : one year per chunk, whole globe -> global view = 1 request
  - 4x and coarser  : all years per chunk -> one request loads the time slider
  - <group>/ts      : base res, (all years, 16, 16) inner chunks in a single
                      shard -> one small range request per clicked pixel

Usage: 05_multiscale.py <manifest.jsonl> <line_index>
"""

import json
import os
import sys

import numpy as np
import xarray as xr
from zarr.codecs import BloscCodec

STORE = os.environ.get("WT_STORE", "/projects/bjey/worldtensor/zarr/worldtensor.zarr")
MIN_DIM = 90  # stop pyramid once the coarsest side is roughly tile-sized
TS_TILE = 16  # 16x16 px tiles: ~40 KB per pixel-history read (lossless)

# NOT sum pooling for "*_sum" variables: in WorldTensor that suffix is a
# *temporal* aggregate (annual total), and the values are intensive (depth,
# rate, density), so spatial pooling must average. Summing scaled every level
# by 4/16/64. Averaging also keeps colours consistent across zoom levels.
RESAMPLING_METHOD = "average"


def compressor() -> BloscCodec:
    # Duplicated from 04_convert.py (scripts run with `python -I`, no shared
    # module): keep the two definitions identical.
    return BloscCodec(cname="zstd", clevel=9, shuffle="shuffle", typesize=4)


def coarsen_once(da: xr.DataArray) -> xr.DataArray:
    # trim, not pad: the 721-row grid includes both poles, so padding gives
    # the last coarse row a centre of 90.0 that no affine transform matches.
    # Trimming drops the odd 90N row from overviews only (base keeps it) and
    # keeps every level exactly affine with coords inside +-90.
    return da.coarsen(boundary="trim", lat=2, lon=2).mean()


def level_chunks(da: xr.DataArray, factor: int) -> tuple[int, ...]:
    ny, nx = da.sizes["lat"], da.sizes["lon"]
    if "time" not in da.dims:
        return (ny, nx)
    nt = da.sizes["time"] if factor >= 4 else 1
    return (nt, ny, nx)


def write_level(
    da: xr.DataArray,
    varname: str,
    attrs: dict,
    spatial_ref: xr.DataArray,
    path: str,
    encoding_extra: dict,
) -> None:
    ds = da.to_dataset(name=varname)
    ds["spatial_ref"] = spatial_ref
    ds[varname].attrs = attrs
    for v in ds.variables:
        ds[v].encoding = {}
    enc = {varname: {"_FillValue": np.float32(np.nan), "compressors": [compressor()], **encoding_extra}}
    ds.to_zarr(STORE, group=path, mode="w", zarr_format=3, encoding=enc, consolidated=False)


def ceil_to_tile(n: int) -> int:
    return -(-n // TS_TILE) * TS_TILE


def write_ts(
    base: xr.DataArray, varname: str, attrs: dict, spatial_ref: xr.DataArray, group_path: str
) -> None:
    nt, ny, nx = base.sizes["time"], base.sizes["lat"], base.sizes["lon"]
    write_level(
        base,
        varname,
        attrs,
        spatial_ref,
        f"{group_path}/ts",
        {"chunks": (nt, TS_TILE, TS_TILE), "shards": (nt, ceil_to_tile(ny), ceil_to_tile(nx))},
    )


def main() -> None:
    manifest_path, idx = sys.argv[1], int(sys.argv[2])
    with open(manifest_path) as fh:
        unit = json.loads(fh.readlines()[idx])

    group_path = unit["group_path"]
    root = xr.open_zarr(STORE, group=group_path, consolidated=False)
    (varname,) = [v for v in root.data_vars if v != "spatial_ref"]
    base = root[varname].load()
    attrs = dict(base.attrs, resampling_method=RESAMPLING_METHOD)
    spatial_ref = root["spatial_ref"].load()

    n_levels = 0
    factor, current = 2, base
    while min(current.sizes["lat"], current.sizes["lon"]) > MIN_DIM:
        current = coarsen_once(current).astype("float32")
        write_level(
            current,
            varname,
            attrs,
            spatial_ref,
            f"{group_path}/{factor}x",
            {"chunks": level_chunks(current, factor)},
        )
        n_levels += 1
        factor *= 2

    if "time" in base.dims:
        write_ts(base, varname, attrs, spatial_ref, group_path)

    # multiscales / proj / spatial attrs are written by 06_geozarr.py
    print(f"{group_path}: built {n_levels} pyramid levels using {RESAMPLING_METHOD}", file=sys.stderr)


if __name__ == "__main__":
    main()
