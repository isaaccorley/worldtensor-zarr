#!/bin/bash
#SBATCH --job-name=wt-finalize
#SBATCH --partition=cpu
#SBATCH --cpus-per-task=1
#SBATCH --mem=2G
#SBATCH --time=01:00:00
#SBATCH --output=/projects/bjey/worldtensor/logs/finalize.out
#SBATCH --error=/projects/bjey/worldtensor/logs/finalize.err

set -euo pipefail
cd /projects/bjey/worldtensor/scripts
: "${WT_STORE:=/projects/bjey/worldtensor/zarr/worldtensor.zarr}"
uv run --with zarr python3 -I 06_consolidate.py
uv run --with xarray --with zarr --with numpy python3 -I 08_catalog.py
du -sh "$WT_STORE"
find "$WT_STORE" -name "zarr.json" | wc -l
