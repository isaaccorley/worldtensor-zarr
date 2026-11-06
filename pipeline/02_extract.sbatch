#!/bin/bash
#SBATCH --job-name=wt-extract
#SBATCH --partition=cpu
#SBATCH --cpus-per-task=2
#SBATCH --mem=4G
#SBATCH --time=04:00:00
#SBATCH --array=0-13
#SBATCH --output=/projects/bjey/worldtensor/logs/extract_%a.out
#SBATCH --error=/projects/bjey/worldtensor/logs/extract_%a.err

set -euo pipefail

BASE=/projects/bjey/worldtensor
MANIFEST="$BASE/scripts/manifest.tsv"

LINE=$(sed -n "$((SLURM_ARRAY_TASK_ID + 1))p" "$MANIFEST")
FNAME=$(echo "$LINE" | cut -f1)
DOMAIN=$(basename "$FNAME" .zip | sed 's/^worldtensor_//')

ZIP="$BASE/raw/zips/$FNAME"
DEST="$BASE/raw/netcdf"
STAGE="$DEST/.stage_$DOMAIN"
DONE="$DEST/.done_$DOMAIN"

if [ -f "$DONE" ]; then
    echo "$DOMAIN already extracted, skipping"
    exit 0
fi

rm -rf "$STAGE"
mkdir -p "$STAGE"
echo "Extracting $FNAME into $STAGE"
unzip -q -o "$ZIP" -d "$STAGE"

# zips nest under a top-level dir matching the domain name; flatten that away
NESTED="$STAGE/$DOMAIN"
if [ -d "$NESTED" ]; then
    mv "$NESTED" "$DEST/$DOMAIN"
else
    mv "$STAGE" "$DEST/$DOMAIN"
fi
rm -rf "$STAGE"

touch "$DONE"
echo "Done extracting $DOMAIN: $(find "$DEST/$DOMAIN" -name '*.nc' | wc -l) nc files"
