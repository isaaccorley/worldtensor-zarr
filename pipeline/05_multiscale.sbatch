#!/bin/bash
#SBATCH --job-name=wt-pyramid
#SBATCH --partition=cpu_amd
#SBATCH --cpus-per-task=2
#SBATCH --mem=8G
#SBATCH --time=02:00:00
#SBATCH --output=/projects/bjey/worldtensor/logs/pyramid_%a.out
#SBATCH --error=/projects/bjey/worldtensor/logs/pyramid_%a.err

set -euo pipefail
cd /projects/bjey/worldtensor/scripts
MANIFEST=/projects/bjey/worldtensor/scripts/variables_manifest.jsonl
uv run --with xarray --with zarr --with numpy --with scipy --with netCDF4 \
    python3 -I 05_multiscale.py "$MANIFEST" "$SLURM_ARRAY_TASK_ID"
