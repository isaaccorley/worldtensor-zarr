#!/bin/bash
#SBATCH --job-name=wt-manifest
#SBATCH --partition=cpu
#SBATCH --cpus-per-task=1
#SBATCH --mem=2G
#SBATCH --time=00:20:00
#SBATCH --output=/projects/bjey/worldtensor/logs/manifest.out
#SBATCH --error=/projects/bjey/worldtensor/logs/manifest.err

set -euo pipefail
cd /projects/bjey/worldtensor/scripts
python3 -I 03_build_manifest.py
N=$(wc -l < variables_manifest.jsonl)
echo "manifest has $N units"

# chain: submit the conversion array job sized to the manifest
LAST=$((N - 1))
CONVERT_JOB=$(sbatch --parsable --array=0-$LAST%64 04_convert.sbatch)
echo "submitted convert array job: $CONVERT_JOB (0-$LAST)"
echo "$CONVERT_JOB" > /projects/bjey/worldtensor/scripts/.convert_job_id

PYRAMID_JOB=$(sbatch --parsable --dependency=afterok:$CONVERT_JOB --array=0-$LAST%64 05_multiscale.sbatch)
echo "submitted pyramid array job: $PYRAMID_JOB (0-$LAST)"
echo "$PYRAMID_JOB" > /projects/bjey/worldtensor/scripts/.pyramid_job_id

CONSOLIDATE_JOB=$(sbatch --parsable --dependency=afterok:$PYRAMID_JOB 06_consolidate.sbatch)
echo "submitted consolidate job: $CONSOLIDATE_JOB"
echo "$CONSOLIDATE_JOB" > /projects/bjey/worldtensor/scripts/.consolidate_job_id

