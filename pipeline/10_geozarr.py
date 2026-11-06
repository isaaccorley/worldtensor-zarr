#!/usr/bin/env python3
"""Write GeoZarr metadata (metadata only, no chunk rewrites).

Layers on top of the CF-1.8 metadata 04/05 already write (spatial_ref grid
mapping with WKT, grid_mapping on data arrays, dimension_names, cell-centre
lat/lon coords):

  * zarr-conventions v0.1 `proj:`, `spatial:` and `multiscales` on each
    variable group, registered in `zarr_conventions`
  * `proj:` / `spatial:` on every pyramid level group and the `ts` group (the
    proj convention only inherits to *direct* child arrays)
  * GDAL `GeoTransform` on every `spatial_ref`, and a CF `coordinates`
    link from each data array to it (so rioxarray resolves the CRS)
  * dataset-level attrs on the root group

Registration is "pixel": the affine maps array index (0, 0) to the outer
corner of the first cell (GDAL convention), so the origin is half a cell
outside the first coordinate value. Rows run south->north (lat ascending), so
the y pixel size `e` is positive. Pyramid levels share the origin; only pixel
size changes (padded 2x halving).

Usage: 10_geozarr.py   (env WT_STORE, WT_MANIFEST)
"""
import json
import os
import sys

import numpy as np
import zarr

STORE = os.environ.get("WT_STORE", "/projects/bjey/worldtensor/zarr/worldtensor.zarr")
MANIFEST = os.environ.get("WT_MANIFEST", "/projects/bjey/worldtensor/scripts/variables_manifest.jsonl")

CONVENTIONS = {
    "multiscales": {
        "schema_url": "https://raw.githubusercontent.com/zarr-conventions/multiscales/refs/tags/v0.1/schema.json",
        "spec_url": "https://github.com/zarr-conventions/multiscales/blob/v0.1/README.md",
        "uuid": "d35379db-88df-4056-af3a-620245f8e347",
        "name": "multiscales",
        "description": "Multiscale layout of zarr datasets",
    },
    "proj": {
        "schema_url": "https://raw.githubusercontent.com/zarr-conventions/proj/refs/tags/v0.1/schema.json",
        "spec_url": "https://github.com/zarr-conventions/proj/blob/v0.1/README.md",
        "uuid": "f17cb550-5864-4468-aeb7-f3180cfb622f",
        "name": "proj",
        "description": "Coordinate reference system information for geospatial data",
    },
    "spatial": {
        "schema_url": "https://raw.githubusercontent.com/zarr-conventions/spatial/refs/tags/v0.1/schema.json",
        "spec_url": "https://github.com/zarr-conventions/spatial/blob/v0.1/README.md",
        "uuid": "689b58e2-cf7b-45e0-9fff-9cfc0883d6b4",
        "name": "spatial",
        "description": "Spatial coordinate information",
    },
}

ROOT_ATTRS = {
    "Conventions": "CF-1.8",
    "title": "WorldTensor (Zarr)",
    "summary": "Harmonized 0.25 degree global Earth-system variables, one GeoZarr "
    "group per variable with a multiscale pyramid and a pixel time-series array.",
    "source": "https://zenodo.org/records/19047618",
    "references": "https://arxiv.org/abs/2607.03298",
    "history": "Converted from the WorldTensor NetCDF release with "
    "https://github.com/isaaccorley/worldtensor-zarr",
}


class Grid:
    """Base-grid geometry, read once from the first variable's coords."""

    def __init__(self, group):
        lat = np.asarray(group["lat"][:], dtype="float64")
        lon = np.asarray(group["lon"][:], dtype="float64")
        self.res_x = float(lon[1] - lon[0])
        self.res_y = float(lat[1] - lat[0])  # > 0: rows run south -> north
        self.x0 = float(lon[0]) - self.res_x / 2  # outer cell edge
        self.y0 = float(lat[0]) - self.res_y / 2
        self.shape = (lat.size, lon.size)

    def level(self, factor, shape):
        ny, nx = shape
        a, e = self.res_x * factor, self.res_y * factor
        transform = [a, 0.0, self.x0, 0.0, e, self.y0]
        bbox = [self.x0, self.y0, self.x0 + nx * a, self.y0 + ny * e]  # xmin ymin xmax ymax
        geotransform = f"{self.x0} {a} 0.0 {self.y0} 0.0 {e}"
        return transform, bbox, geotransform


def geo_attrs(transform, shape, bbox):
    return {
        "proj:code": "EPSG:4326",
        "spatial:dimensions": ["lat", "lon"],
        "spatial:transform": transform,
        "spatial:shape": list(shape),
        "spatial:bbox": bbox,
        "spatial:registration": "pixel",
    }


def set_geotransform(group, geotransform):
    if "spatial_ref" in group:
        group["spatial_ref"].attrs["GeoTransform"] = geotransform


def link_crs(array):
    """CF `coordinates` link so xarray decodes spatial_ref as a coordinate of
    the data variable; without it `ds[var].rio.crs` is None even though
    `grid_mapping` is set (the grid-mapping var stays a separate data var)."""
    array.attrs["coordinates"] = "spatial_ref"


def factor_of(level):
    return 1 if level == "." else int(level.rstrip("x"))


def open_fresh(path):
    """Open a group from its own zarr.json, never from consolidated metadata:
    a stale consolidated snapshot (e.g. from before a pyramid rebuild) would
    hand back old array shapes, and writing attrs then re-serializes those
    stale shapes over the real metadata."""
    return zarr.open_group(STORE, path=path, mode="r+", use_consolidated=False)


def patch_variable(grid, group_path):
    g = open_fresh(group_path)
    (var,) = [k for k, a in g.arrays() if k not in {"lat", "lon", "time", "spatial_ref"}]
    # discover levels from child groups ("2x", "4x", ...) so this is
    # idempotent and independent of whatever multiscales attr exists
    subs = sorted((k for k, _ in g.groups() if k.endswith("x") and k[:-1].isdigit()), key=factor_of)
    levels = [".", *subs]
    method = g[subs[0]][var].attrs.get("resampling_method", "average") if subs else "average"

    layout = []
    for level in levels:
        node = g if level == "." else open_fresh(f"{group_path}/{level}")
        shape = node[var].shape[-2:]
        f = factor_of(level)
        transform, bbox, gt = grid.level(f, shape)
        set_geotransform(node, gt)
        link_crs(node[var])
        item = {
            "asset": var if level == "." else f"{level}/{var}",
            "transform": {"scale": [float(f), float(f)], "translation": [0.0, 0.0]},
            "spatial:transform": transform,
            "spatial:shape": list(shape),
        }
        if level != ".":
            prev = levels[levels.index(level) - 1]
            item["derived_from"] = var if prev == "." else f"{prev}/{var}"
            item["resampling_method"] = method
            node.attrs.update({
                "zarr_conventions": [CONVENTIONS["proj"], CONVENTIONS["spatial"]],
                **geo_attrs(transform, shape, bbox),
            })
        layout.append(item)

    base_shape = g[var].shape[-2:]
    transform, bbox, _ = grid.level(1, base_shape)
    g.attrs.update({
        "zarr_conventions": [CONVENTIONS["multiscales"], CONVENTIONS["proj"], CONVENTIONS["spatial"]],
        "multiscales": {"layout": layout, "resampling_method": method},
        **geo_attrs(transform, base_shape, bbox),
    })

    if "ts" in g:
        ts = open_fresh(f"{group_path}/ts")
        _, _, gt = grid.level(1, base_shape)
        set_geotransform(ts, gt)
        link_crs(ts[var])
        ts.attrs.update({
            "zarr_conventions": [CONVENTIONS["proj"], CONVENTIONS["spatial"]],
            **geo_attrs(transform, base_shape, bbox),
        })


def main():
    with open(MANIFEST) as fh:
        groups = [json.loads(line)["group_path"] for line in fh]
    root = open_fresh("")
    grid = Grid(open_fresh(groups[0]))
    print(f"grid: shape={grid.shape} res=({grid.res_x}, {grid.res_y}) origin=({grid.x0}, {grid.y0})")
    for i, gp in enumerate(groups):
        patch_variable(grid, gp)
        if i % 100 == 0:
            print(f"{i}/{len(groups)} {gp}", flush=True)
    root.attrs.update(ROOT_ATTRS)
    print(f"patched {len(groups)} variable groups", file=sys.stderr)


if __name__ == "__main__":
    main()
