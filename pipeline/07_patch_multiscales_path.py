#!/usr/bin/env python3
"""One-time patch: fix the base-level 'path' in each group's multiscales attr
from '0' (wrong - implied a nonexistent sibling subgroup) to '.' (correct -
the base level lives in the group itself). Metadata-only, no array rewrite.
"""
import json

import zarr

STORE = "/projects/bjey/worldtensor/zarr/worldtensor.zarr"
MANIFEST = "/projects/bjey/worldtensor/scripts/variables_manifest.jsonl"


def main():
    root = zarr.open_group(STORE, mode="r+")
    patched = 0
    with open(MANIFEST) as fh:
        for line in fh:
            unit = json.loads(line)
            group_path = unit["group_path"]
            grp = root[group_path]
            ms = grp.attrs.get("multiscales")
            if not ms:
                print(f"SKIP (no multiscales attr): {group_path}")
                continue
            datasets = ms[0]["datasets"]
            if datasets[0]["path"] == "0":
                datasets[0]["path"] = "."
                grp.attrs["multiscales"] = ms
                patched += 1
            elif datasets[0]["path"] != ".":
                print(f"UNEXPECTED base path for {group_path}: {datasets[0]}")
    print(f"patched {patched} groups")


if __name__ == "__main__":
    main()
