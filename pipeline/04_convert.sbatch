#!/bin/bash
#SBATCH --job-name=wt-convert
#SBATCH --partition=cpu_amd
#SBATCH --cpus-per-task=2
#SBATCH --mem=6G
#SBATCH --time=02:00:00
#SBATCH --output=/projects/bjey/worldtensor/logs/convert_%a.out
#SBATCH --error=/projects/bjey/worldtensor/logs/convert_%a.err

set -euo pipefail
cd /projects/bjey/worldtensor/scripts
MANIFEST=/projects/bjey/worldtensor/scripts/variables_manifest.jsonl
uv run --with xarray --with netCDF4 --with zarr --with pandas --with numpy \
    python3 -I 04_convert.py "$MANIFEST" "$SLURM_ARRAY_TASK_ID"
