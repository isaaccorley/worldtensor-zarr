#!/usr/bin/env python3
"""Validate GeoZarr metadata in the finished store (read-only).

Checks per variable group, from the official zarr-conventions v0.1 schemas
(pipeline/schemas/):
  * `multiscales`, `spatial` and `proj` schemas on the group's zarr.json
  * `spatial` and `proj` schemas on every pyramid level group and on `ts`
and per pyramid level:
  * `spatial:transform` agrees with the first AND last coordinate value
  * |lat| <= 90, `spatial:shape` equals the array shape
  * rioxarray resolves the CRS to EPSG:4326
  * the GDAL `GeoTransform` string on spatial_ref equals the affine

Usage: 09_validate.py [n_sample] [--store PATH] [--manifest PATH]
  n_sample   validate a random (seeded) sample of that many groups, default all
  --store    default $WT_STORE
  --manifest default $WT_MANIFEST
Exit status is 1 if any check fails.
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path

import jsonschema
import numpy as np
import rioxarray  # noqa: F401  (registers the .rio accessor)
import xarray as xr

HERE = Path(__file__).resolve().parent
SCHEMA_DIR = HERE / "schemas"
SCHEMA_NAMES = ("multiscales", "spatial", "proj")
MAX_ERRORS_SHOWN = 25

DEFAULT_STORE = "/projects/bjey/worldtensor/zarr/worldtensor.zarr"
DEFAULT_MANIFEST = "/projects/bjey/worldtensor/scripts/variables_manifest.jsonl"


def load_schemas() -> dict[str, dict]:
    return {k: json.loads((SCHEMA_DIR / f"{k}.schema.json").read_text()) for k in SCHEMA_NAMES}


def read_meta(store: str, path: str) -> dict:
    with open(os.path.join(store, path, "zarr.json")) as fh:
        return json.load(fh)


def schema_errors(meta: dict, label: str, names: tuple[str, ...], schemas: dict[str, dict]) -> list[str]:
    errors = []
    for k in names:
        try:
            jsonschema.validate(meta, schemas[k])
        except jsonschema.ValidationError as e:
            errors.append(f"{label} [{k}] {e.message[:160]}")
    return errors


def check_level(store: str, lvl_group: str, item: dict) -> list[str]:
    """Check one multiscales layout item against the level's real coordinates."""
    errors = []
    ds = xr.open_zarr(os.path.join(store, lvl_group), consolidated=False)
    a, _, c, _, e, f = item["spatial:transform"]
    lon, lat = ds.lon.values, ds.lat.values
    ny, nx = ds.sizes["lat"], ds.sizes["lon"]

    lon0, lat0 = c + 0.5 * a, f + 0.5 * e
    if not (np.isclose(lon[0], lon0) and np.isclose(lat[0], lat0)):
        errors.append(f"{lvl_group}: centre of (0,0) {lon0},{lat0} != coords {lon[0]},{lat[0]}")
    lon_n, lat_n = c + (nx - 0.5) * a, f + (ny - 0.5) * e
    if not (np.isclose(lon[-1], lon_n) and np.isclose(lat[-1], lat_n)):
        errors.append(f"{lvl_group}: centre of last cell {lon_n},{lat_n} != coords {lon[-1]},{lat[-1]}")
    if np.abs(lat).max() > 90:
        errors.append(f"{lvl_group}: |lat| > 90")
    if list(item["spatial:shape"]) != [ny, nx]:
        errors.append(f"{lvl_group}: spatial:shape mismatch")

    var = item["asset"].split("/")[-1]
    crs = ds[var].rio.crs
    if crs is None or crs.to_epsg() != 4326:
        errors.append(f"{lvl_group}: rio.crs={crs}")
    gt = ds["spatial_ref"].attrs.get("GeoTransform", "")
    if [float(x) for x in gt.split()] != [c, a, 0.0, f, 0.0, e]:
        errors.append(f"{lvl_group}: GeoTransform {gt!r}")
    return errors


def check_group(store: str, group: str, schemas: dict[str, dict]) -> tuple[list[str], int]:
    """Validate one variable group; returns (errors, number of levels checked)."""
    meta = read_meta(store, group)
    errors = schema_errors(meta, group, SCHEMA_NAMES, schemas)
    levels = 0
    for item in meta["attributes"]["multiscales"]["layout"]:
        lvl_group = group if "/" not in item["asset"] else f"{group}/{item['asset'].split('/')[0]}"
        if lvl_group != group:
            errors += schema_errors(read_meta(store, lvl_group), lvl_group, ("spatial", "proj"), schemas)
        errors += check_level(store, lvl_group, item)
        levels += 1
    if "ts" in os.listdir(os.path.join(store, group)):
        # one message per ts group, first failing schema wins
        ts_errors = schema_errors(
            read_meta(store, f"{group}/ts"), f"{group}/ts", ("spatial", "proj"), schemas
        )
        errors += ts_errors[:1]
    return errors, levels


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Validate GeoZarr metadata (read-only).")
    p.add_argument("n_sample", nargs="?", type=int, default=None, help="random sample size (default: all)")
    p.add_argument("--store", default=os.environ.get("WT_STORE", DEFAULT_STORE))
    p.add_argument("--manifest", default=os.environ.get("WT_MANIFEST", DEFAULT_MANIFEST))
    return p.parse_args()


def main() -> None:
    args = parse_args()
    schemas = load_schemas()
    with open(args.manifest) as fh:
        groups = [json.loads(line)["group_path"] for line in fh]
    random.seed(0)
    if args.n_sample is not None and len(groups) > args.n_sample:
        groups = random.sample(groups, args.n_sample)

    errors: list[str] = []
    checked = 0
    for g in groups:
        group_errors, levels = check_group(args.store, g, schemas)
        errors += group_errors
        checked += levels
    print(f"variables={len(groups)} levels_checked={checked} errors={len(errors)}")
    print("\n".join(errors[:MAX_ERRORS_SHOWN]))
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
