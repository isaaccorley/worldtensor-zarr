#!/usr/bin/env python3
"""Convert one (domain, group, variable) manifest unit into a self-contained
GeoZarr group inside the central worldtensor.zarr store.

Usage: 04_convert.py <manifest.jsonl> <line_index>
"""
import json
import sys

import numpy as np
import pandas as pd
import xarray as xr

STORE = "/projects/bjey/worldtensor/zarr/worldtensor.zarr"

CRS_WKT = (
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],'
    'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],'
    'AUTHORITY["EPSG","4326"]]'
)


def grid_mapping_var():
    da = xr.DataArray(0, name="spatial_ref")
    da.attrs = {
        "grid_mapping_name": "latitude_longitude",
        "crs_wkt": CRS_WKT,
        "spatial_ref": CRS_WKT,
        "semi_major_axis": 6378137.0,
        "inverse_flattening": 298.257223563,
        "longitude_of_prime_meridian": 0.0,
    }
    return da


def pick_chunks(n_time, n_lat, n_lon):
    lat_chunk = min(n_lat, 361)
    lon_chunk = min(n_lon, 480)
    time_chunk = min(n_time, 8) if n_time else None
    return time_chunk, lat_chunk, lon_chunk


def load_unit(unit):
    kind = unit["kind"]
    files = unit["files"]

    if kind == "static":
        ds = xr.open_dataset(files[0])
        (varname,) = [v for v in ds.data_vars]
        da = ds[varname]
        da = da.rename(varname.replace("/", "_"))
        return da, None

    arrays = []
    for f, year in zip(files, unit["years"]):
        ds = xr.open_dataset(f)
        (varname,) = [v for v in ds.data_vars]
        da = ds[varname]
        # some source files already carry a size-1 "time" dim, others don't -
        # normalize to no time dim before stamping our own time coordinate
        if "time" in da.dims:
            da = da.isel(time=0, drop=True)
        arrays.append(da.expand_dims(time=[pd.Timestamp(f"{year}-01-01")]))
    da = xr.concat(arrays, dim="time")
    da = da.rename(varname.replace("/", "_"))
    return da, varname


def main():
    manifest_path, idx = sys.argv[1], int(sys.argv[2])
    with open(manifest_path) as fh:
        lines = fh.readlines()
    unit = json.loads(lines[idx])

    group_path = unit["group_path"]
    da, orig_varname = load_unit(unit)
    da = da.astype("float32")

    ds = da.to_dataset()
    ds.attrs["Conventions"] = "CF-1.8"
    ds.attrs["source_domain"] = unit["domain"]
    ds["spatial_ref"] = grid_mapping_var()
    for v in ds.data_vars:
        if v == "spatial_ref":
            continue
        ds[v].attrs["grid_mapping"] = "spatial_ref"
        ds[v].attrs.setdefault("original_variable_name", orig_varname or v)

    ds["lat"].attrs.update(standard_name="latitude", units="degrees_north", axis="Y")
    ds["lon"].attrs.update(standard_name="longitude", units="degrees_east", axis="X")

    n_time = ds.sizes.get("time", 0)
    n_lat = ds.sizes["lat"]
    n_lon = ds.sizes["lon"]
    time_chunk, lat_chunk, lon_chunk = pick_chunks(n_time, n_lat, n_lon)

    encoding = {}
    for v in ds.data_vars:
        if v == "spatial_ref":
            continue
        if n_time:
            chunks = (time_chunk, lat_chunk, lon_chunk)
        else:
            chunks = (lat_chunk, lon_chunk)
        encoding[v] = {"chunks": chunks, "_FillValue": np.float32(np.nan)}

    ds.to_zarr(
        STORE,
        group=group_path,
        mode="w",
        zarr_format=3,
        encoding=encoding,
        consolidated=False,
    )
    print(f"wrote group={group_path} shape={dict(ds.sizes)}", file=sys.stderr)


if __name__ == "__main__":
    main()
