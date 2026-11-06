#!/bin/bash
#SBATCH --job-name=wt-convert
#SBATCH --partition=cpu_amd
#SBATCH --cpus-per-task=2
#SBATCH --mem=3G
#SBATCH --time=00:30:00
#SBATCH --output=/projects/bjey/worldtensor/logs/convert_%a.out
#SBATCH --error=/projects/bjey/worldtensor/logs/convert_%a.err

set -euo pipefail
cd /projects/bjey/worldtensor/scripts
MANIFEST=/projects/bjey/worldtensor/scripts/variables_manifest.jsonl
# retry: 64 concurrent tasks can race on the shared uv cache (EBUSY);
# the scripts are idempotent (mode="w") so a rerun is safe
for attempt in 1 2 3; do
    uv run --with xarray --with netCDF4 --with zarr --with pandas --with numpy \
        python3 -I 04_convert.py "$MANIFEST" "$SLURM_ARRAY_TASK_ID" && exit 0
    echo "attempt $attempt failed" >&2; sleep $((RANDOM % 20 + 5))
done
exit 1
