#!/usr/bin/env python3
import zarr

STORE = "/projects/bjey/worldtensor/zarr/worldtensor.zarr"

zarr.consolidate_metadata(STORE)
print("consolidated metadata written")
