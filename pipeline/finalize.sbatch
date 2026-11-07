#!/bin/bash
#SBATCH --job-name=wt-finalize
#SBATCH --partition=cpu
#SBATCH --cpus-per-task=1
#SBATCH --mem=2G
#SBATCH --time=01:30:00
#SBATCH --output=/projects/bjey/worldtensor/logs/finalize.out
#SBATCH --error=/projects/bjey/worldtensor/logs/finalize.err

# GeoZarr attrs -> per-group consolidated metadata -> viewer catalog.json -> validate (fails the job on error)
set -euo pipefail
cd /projects/bjey/worldtensor/scripts
: "${WT_STORE:=/projects/bjey/worldtensor/zarr/worldtensor.zarr}"
uv run --with zarr --with numpy python3 -I 06_geozarr.py
uv run --with zarr python3 -I 07_consolidate.py
uv run --with xarray --with zarr --with numpy python3 -I 08_catalog.py
uv run --with jsonschema --with rioxarray --with xarray --with zarr python3 -I 09_validate.py
