#!/usr/bin/env python3
"""Add a multiscale pyramid (halving, cascaded) to one variable group of the
central worldtensor.zarr store.

Resampling is chosen from the variable's semantics:
  - name ends with "_sum" -> sum pooling
  - integer dtype         -> mode (categorical)
  - otherwise             -> average (continuous / mean / fraction)

Survey of the source NetCDFs found every variable on disk is float32, nodata as
NaN, no scale/offset, and no true categorical class-id raster (e.g.
"vegetation_class" is actually 18 separate float32 fractional presence masks,
one per class, not a single integer label array) - so name-sniffing for
"class" is deliberately NOT used here, only dtype.

Usage: 05_multiscale.py <manifest.jsonl> <line_index>
"""
import json
import sys
from pathlib import Path

import numpy as np
import xarray as xr
from scipy import stats

STORE = "/projects/bjey/worldtensor/zarr/worldtensor.zarr"
MIN_DIM = 90  # stop pyramid once the coarsest side is roughly tile-sized


def resampling_method(varname: str, dtype) -> str:
    name = varname.lower()
    if name.endswith("_sum"):
        return "sum"
    if np.issubdtype(dtype, np.integer):
        return "mode"
    return "average"


def mode_reduce(block, axis):
    m, _ = stats.mode(block, axis=axis, nan_policy="omit", keepdims=False)
    return m


def coarsen_once(da: xr.DataArray, method: str) -> xr.DataArray:
    coarsen_dims = {"lat": 2, "lon": 2}
    c = da.coarsen(boundary="pad", **coarsen_dims)
    if method == "sum":
        return c.sum()
    if method == "mode":
        return c.reduce(mode_reduce)
    return c.mean()


def main():
    manifest_path, idx = sys.argv[1], int(sys.argv[2])
    with open(manifest_path) as fh:
        unit = json.loads(fh.readlines()[idx])

    group_path = unit["group_path"]
    root = xr.open_zarr(STORE, group=group_path, consolidated=False)
    (varname,) = [v for v in root.data_vars if v != "spatial_ref"]
    method = resampling_method(varname, root[varname].dtype)

    levels = [("0", group_path, root[varname])]
    factor = 2
    current = root[varname]
    while min(current.sizes["lat"], current.sizes["lon"]) > MIN_DIM:
        current = coarsen_once(current, method)
        level_name = f"{factor}x"
        levels.append((level_name, f"{group_path}/{level_name}", current))
        factor *= 2

    for level_name, path, da in levels[1:]:
        ds = da.to_dataset(name=varname)
        ds["spatial_ref"] = root["spatial_ref"]
        ds[varname].attrs = root[varname].attrs
        ds[varname].attrs["resampling_method"] = method
        encoding = {varname: {"_FillValue": np.float32(np.nan)}}
        ds.to_zarr(STORE, group=path, mode="w", zarr_format=3, encoding=encoding, consolidated=False)

    # record the multiscales attribute on the base group
    import zarr

    grp = zarr.open_group(STORE, path=group_path, mode="r+")
    grp.attrs["multiscales"] = [{
        "tile_matrix_set": "WGS84Quad",
        "resampling_method": method,
        "datasets": [{"path": name} for name, _, _ in levels],
    }]

    print(f"{group_path}: built {len(levels) - 1} pyramid levels using {method}", file=sys.stderr)


if __name__ == "__main__":
    main()
