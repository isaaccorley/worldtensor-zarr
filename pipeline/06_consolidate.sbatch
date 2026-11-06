#!/bin/bash
#SBATCH --job-name=wt-consolidate
#SBATCH --partition=cpu
#SBATCH --cpus-per-task=1
#SBATCH --mem=4G
#SBATCH --time=00:30:00
#SBATCH --output=/projects/bjey/worldtensor/logs/consolidate.out
#SBATCH --error=/projects/bjey/worldtensor/logs/consolidate.err

set -euo pipefail
cd /projects/bjey/worldtensor/scripts
uv run --with zarr python3 -I 06_consolidate.py
du -sh /projects/bjey/worldtensor/zarr/worldtensor.zarr
find /projects/bjey/worldtensor/zarr/worldtensor.zarr -name "zarr.json" | wc -l
