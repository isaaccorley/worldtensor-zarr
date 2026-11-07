#!/bin/bash
# Submit convert -> pyramid(+ts) -> finalize, sized to the manifest.
# WT_STORE (exported to jobs) selects the output store.
set -euo pipefail
cd /projects/bjey/worldtensor/scripts
export WT_STORE="${WT_STORE:-/projects/bjey/worldtensor/zarr/worldtensor.zarr}"
N=$(wc -l < variables_manifest.jsonl)
LAST=$((N - 1))
CONVERT_JOB=$(sbatch --parsable --array=0-$LAST%64 04_convert.sbatch)
PYRAMID_JOB=$(sbatch --parsable --dependency=afterok:$CONVERT_JOB --array=0-$LAST%64 05_multiscale.sbatch)
FINALIZE_JOB=$(sbatch --parsable --dependency=afterok:$PYRAMID_JOB finalize.sbatch)
echo "$CONVERT_JOB" > .convert_job_id
echo "$PYRAMID_JOB" > .pyramid_job_id
echo "$FINALIZE_JOB" > .finalize_job_id
echo "store=$WT_STORE units=$N convert=$CONVERT_JOB pyramid=$PYRAMID_JOB finalize=$FINALIZE_JOB"
