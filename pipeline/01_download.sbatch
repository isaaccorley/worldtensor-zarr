#!/bin/bash
#SBATCH --job-name=wt-dl
#SBATCH --partition=cpu
#SBATCH --cpus-per-task=1
#SBATCH --mem=2G
#SBATCH --time=06:00:00
#SBATCH --array=0-13
#SBATCH --output=/projects/bjey/worldtensor/logs/download_%a.out
#SBATCH --error=/projects/bjey/worldtensor/logs/download_%a.err

set -euo pipefail

BASE=/projects/bjey/worldtensor
MANIFEST="$BASE/scripts/manifest.tsv"
RECORD=19047618

LINE=$(sed -n "$((SLURM_ARRAY_TASK_ID + 1))p" "$MANIFEST")
FNAME=$(echo "$LINE" | cut -f1)
SIZE=$(echo "$LINE" | cut -f2)
MD5=$(echo "$LINE" | cut -f3)

DEST="$BASE/raw/zips/$FNAME"
URL="https://zenodo.org/api/records/$RECORD/files/$FNAME/content"

echo "Downloading $FNAME ($SIZE bytes, md5 $MD5)"

if [ -f "$DEST" ]; then
    ACTUAL=$(md5sum "$DEST" | cut -d' ' -f1)
    if [ "$ACTUAL" = "$MD5" ]; then
        echo "$FNAME already present with correct checksum, skipping"
        exit 0
    fi
fi

for attempt in 1 2 3 4 5; do
    curl -sL --retry 3 --retry-delay 10 -o "$DEST.part" "$URL"
    mv "$DEST.part" "$DEST"
    ACTUAL=$(md5sum "$DEST" | cut -d' ' -f1)
    if [ "$ACTUAL" = "$MD5" ]; then
        echo "OK: $FNAME checksum verified"
        exit 0
    fi
    echo "Attempt $attempt: checksum mismatch for $FNAME (got $ACTUAL, want $MD5), retrying"
    rm -f "$DEST"
    sleep 5
done

echo "FAILED to download $FNAME after 5 attempts" >&2
exit 1
