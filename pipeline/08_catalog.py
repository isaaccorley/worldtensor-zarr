#!/usr/bin/env python3
"""Write <store>/catalog.json: everything the web viewer needs up front, so it
makes zero metadata round trips after startup.

Per variable: path, units/long_name, years, resampling method, color range
(p2/p98 over all years at 4x), and per array (each pyramid level + ts) the
shape and chunk/shard shape. Codec, dtype and fill are uniform across the store
and recorded once in "array_template"; the client synthesizes each array's
zarr.json from template + shape/chunks.
"""
import json
import os

import numpy as np
import xarray as xr

STORE = os.environ.get("WT_STORE", "/projects/bjey/worldtensor/zarr/worldtensor.zarr")
MANIFEST = os.environ.get("WT_MANIFEST", "/projects/bjey/worldtensor/scripts/variables_manifest.jsonl")


def compact_years(years):
    """{"start","end"} for a contiguous run, else the explicit list."""
    if not years:
        return None
    ys = [int(y) for y in years]
    if ys == list(range(ys[0], ys[-1] + 1)):
        return {"start": ys[0], "end": ys[-1]}
    return ys


def weighted_percentile(values, weights, qs):
    order = np.argsort(values)
    v, cw = values[order], np.cumsum(weights[order])
    cw /= cw[-1]
    return np.interp(np.asarray(qs) / 100, cw, v)


def array_meta(store, path, name):
    with open(os.path.join(store, path, name, "zarr.json")) as fh:
        meta = json.load(fh)
    out = {"shape": meta["shape"]}
    codecs = meta["codecs"]
    if codecs[0]["name"] == "sharding_indexed":
        out["shard_shape"] = meta["chunk_grid"]["configuration"]["chunk_shape"]
        out["chunk_shape"] = codecs[0]["configuration"]["chunk_shape"]
    else:
        out["chunk_shape"] = meta["chunk_grid"]["configuration"]["chunk_shape"]
    return out, meta


def main():
    with open(MANIFEST) as fh:
        units = [json.loads(line) for line in fh]

    template = None
    variables = []
    for unit in units:
        g = unit["group_path"]
        ds = xr.open_zarr(STORE, group=g, consolidated=False)
        (v,) = [k for k in ds.data_vars if k != "spatial_ref"]
        ms = ds.attrs["multiscales"]  # zarr-conventions v0.1 layout (10_geozarr.py)
        level_paths = ["." if "/" not in item["asset"] else item["asset"].split("/")[0] for item in ms["layout"]]
        arrays = {}
        for lvl in level_paths + (["ts"] if "time" in ds[v].dims else []):
            sub = g if lvl == "." else f"{g}/{lvl}"
            arrays[lvl], meta = array_meta(STORE, sub, v)
            if template is None and lvl == ".":
                template = {k: meta[k] for k in ("data_type", "fill_value", "codecs")}
        # color range from the 4x level (all years, small) - or coarsest available
        stat_lvl = "4x" if "4x" in arrays else level_paths[-1]
        sds = ds if stat_lvl == "." else xr.open_zarr(STORE, group=f"{g}/{stat_lvl}", consolidated=False)
        vals = sds[v].values
        # weight by cell area (cos lat): on an equal-angle grid the tiny polar
        # cells are heavily over-counted, which drags e.g. t2m's p2 to 226 K
        w = np.broadcast_to(np.cos(np.deg2rad(sds["lat"].values))[:, None], vals.shape[-2:])
        w = np.broadcast_to(w, vals.shape)
        ok = np.isfinite(vals)
        finite, wts = vals[ok], w[ok]
        if finite.size:
            p2, p98 = (float(x) for x in weighted_percentile(finite, wts, [2, 98]))
            vmin, vmax = float(finite.min()), float(finite.max())
        else:
            p2 = p98 = vmin = vmax = None
        a = ds[v].attrs
        variables.append({
            "path": g,
            "name": v,
            "domain": unit["domain"],
            "units": a.get("units"),
            "long_name": a.get("long_name"),
            "years": compact_years(unit.get("years")),
            "resampling": ms.get("resampling_method", "average"),
            "range": {"p2": p2, "p98": p98, "min": vmin, "max": vmax},
            "arrays": arrays,
        })
        print(g, flush=True)

    lat = xr.open_zarr(STORE, group=units[0]["group_path"], consolidated=False).lat.values
    lon = xr.open_zarr(STORE, group=units[0]["group_path"], consolidated=False).lon.values
    catalog = {
        "version": 1,
        "grid": {
            "crs": "EPSG:4326",
            "shape": [int(lat.size), int(lon.size)],
            "lat_first": float(lat[0]), "lat_last": float(lat[-1]),
            "lon_first": float(lon[0]), "lon_last": float(lon[-1]),
            "resolution": float(lon[1] - lon[0]),
            "lat_order": "ascending" if lat[1] > lat[0] else "descending",
            "note": "cell centers; lon in [0, 360); pyramid level k halves both dims (odd trailing row trimmed)",
        },
        "array_template": template,
        "variables": variables,
    }
    out = os.path.join(STORE, "catalog.json")
    with open(out, "w") as fh:
        json.dump(catalog, fh, separators=(",", ":"))
    print(f"wrote {out}: {len(variables)} variables, {os.path.getsize(out)/1e3:.0f} KB")


if __name__ == "__main__":
    main()
