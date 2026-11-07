#!/usr/bin/env python3
"""Consolidate metadata per variable group (not at the root).

A root-level consolidated zarr.json for ~22k nodes is ~24MB, which a browser
would have to download before drawing anything. Per-group consolidation keeps
each variable's pyramid openable in one request (~tens of KB) for xarray users,
while the web viewer gets its metadata from catalog.json (08_catalog.py).
"""

import json
import os

import zarr

STORE = os.environ.get("WT_STORE", "/projects/bjey/worldtensor/zarr/worldtensor.zarr")
MANIFEST = os.environ.get("WT_MANIFEST", "/projects/bjey/worldtensor/scripts/variables_manifest.jsonl")


def main() -> None:
    with open(MANIFEST) as fh:
        groups = [json.loads(line)["group_path"] for line in fh]
    for g in groups:
        zarr.consolidate_metadata(STORE, path=g, zarr_format=3)
    print(f"consolidated {len(groups)} groups")


if __name__ == "__main__":
    main()
