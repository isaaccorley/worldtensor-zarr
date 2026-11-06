# worldtensor

NetCDF -> GeoZarr conversion, multiscale pyramids, and a visualization webapp
for [WorldTensor](https://arxiv.org/abs/2607.03298), a harmonized Earth system
dataset ([Zenodo](https://zenodo.org/records/19047618)).

## Pipeline

Runs on the RAILS cluster via SLURM, chained end to end with job dependencies:

1. `01_download.sbatch` — fetch the 14 Zenodo zip archives (48.5 GB), checksum-verified
2. `02_extract.sbatch` — unzip each domain to `raw/netcdf/<domain>/...`
3. `03_build_manifest.py` / `.sbatch` — enumerate every (domain, variable) unit, then
   self-submits the remaining stages sized to the manifest
4. `04_convert.py` / `.sbatch` — convert each variable to a self-contained GeoZarr
   group (own lat/lon/time coords, CF-1.8 `spatial_ref`) in a single
   `worldtensor.zarr` store
5. `05_multiscale.py` / `.sbatch` — cascaded halving pyramid per variable, resampling
   chosen by semantics (`sum`/`mode`/`average`)
6. `06_consolidate.py` / `.sbatch` — consolidate Zarr metadata for fast remote opens

Working data lives on `/projects/bjey/worldtensor` (not in git).

## Status

Conversion pipeline running. Next: local viz webapp, then rehost the zarr store
to Source Cooperative (`taylor-geospatial` org) and switch the webapp to HTTPS
range requests against it.
