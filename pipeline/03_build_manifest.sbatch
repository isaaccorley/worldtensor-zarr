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

# chain: convert -> pyramid -> finalize
./submit_chain.sh
