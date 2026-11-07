# WorldTensor to GeoZarr pipeline

SLURM scripts that convert the WorldTensor NetCDF release (Zenodo record 19047618) into one GeoZarr v3 store with a multiscale pyramid and a per-pixel time-series array for every variable. The scripts are not a package: each `.py` file runs standalone with `python3 -I` and shares no code with the others.

## Prerequisites

- RAILS SLURM cluster (NCSA) with the `cpu` and `cpu_amd` partitions.
- `uv` on the login node. The sbatch files install dependencies per job with `uv run --with ...`.
- Working tree on shared storage under `/projects/bjey/worldtensor`:

| Path | Contents |
| --- | --- |
| `raw/zips/` | Zenodo zip files (step 01) |
| `raw/netcdf/` | Extracted NetCDF files, one directory per domain (step 02) |
| `zarr/worldtensor.zarr` | Output store (steps 04 to 08) |
| `logs/` | SLURM stdout/stderr, must exist before submitting |
| `scripts/` | Copy of this `pipeline/` directory, including `manifest.tsv` and `schemas/`. All sbatch files `cd` here. |

`manifest.tsv` (tab separated: file name, size, md5) lists the 14 Zenodo zips and drives steps 01 and 02. Step 03 writes `scripts/variables_manifest.jsonl`, which drives everything after it.

## Steps

| Step | File | Reads | Writes | Resources |
| --- | --- | --- | --- | --- |
| 01 | `01_download.sbatch` (array 0-13) | Zenodo API, `manifest.tsv` | `raw/zips/*.zip` | 1 CPU, 2 GB, 6 h, `cpu` |
| 02 | `02_extract.sbatch` (array 0-13) | `raw/zips` | `raw/netcdf/<domain>/` | 2 CPU, 4 GB, 4 h, `cpu` |
| 03 | `03_build_manifest.sbatch` + `.py` | `raw/netcdf` | `variables_manifest.jsonl`, then runs `submit_chain.sh` | 1 CPU, 2 GB, 20 min, `cpu` |
| 04 | `04_convert.sbatch` + `.py` (array) | one manifest line | group `<domain>/.../<var>` in the store | 2 CPU, 3 GB, 30 min, `cpu_amd` |
| 05 | `05_multiscale.sbatch` + `.py` (array) | base array of one group | `2x`, `4x`, `8x` level groups and `ts` | 2 CPU, 4 GB, 30 min, `cpu_amd` |
| 06-09 | `finalize.sbatch` runs `06_geozarr.py` → `07_consolidate.py` → `08_catalog.py` → `09_validate.py` | whole store | GeoZarr attrs, consolidated metadata, `catalog.json`, validation | 1 CPU, 2 GB, 90 min, `cpu` |

Details per step:

- **01** downloads each zip, verifies its md5 against `manifest.tsv`, and retries up to five times. Already verified files are skipped.
- **02** unzips into a staging directory, flattens the top-level domain directory, and touches `raw/netcdf/.done_<domain>` so reruns skip finished domains.
- **03** walks `raw/netcdf` and writes one JSON line per variable unit: `static` (one `<var>.nc`) or `temporal` (a directory of `<YYYY>.nc` files stacked on time). It then calls `submit_chain.sh`.
- **04** converts one unit to float32 with CF-1.8 metadata and a `spatial_ref` grid-mapping variable. Chunks are one year by 361 x 360 (2 x 4 spatial tiles on the 721 x 1440 grid), or 361 x 360 for static variables. Idempotent (`mode="w"`).
- **05** builds the pyramid by 2x2 averaging with `coarsen(boundary="trim")`, cascading level to level until the shorter side is 90 or less (2x, 4x, 8x). The odd 90N row is dropped from overviews only. Every level averages, including `*_sum` variables, because that suffix is a temporal aggregate and the values are intensive; the `resampling_method` attribute is `average`. For temporal variables it also writes the `ts` group (see layout below).
- **06-09 (`finalize.sbatch`)** runs four scripts in order, and fails if any of them fails:
  1. `06_geozarr.py` writes GeoZarr metadata only (zarr-conventions v0.1 `proj:`, `spatial:` and `multiscales` on groups, levels and `ts`; GDAL `GeoTransform`; CF `coordinates` link; root dataset attrs).
  2. `07_consolidate.py` consolidates metadata per variable group (a root-level consolidated `zarr.json` for about 22k nodes is roughly 24 MB, too large for a browser to fetch up front).
  3. `08_catalog.py` writes `catalog.json` at the store root: per-variable path, units, years, resampling, color range (area-weighted p2/p98 over all years at 4x), and shape and chunk shape of every array, plus a shared `array_template` (dtype, fill value, codecs).
  4. `09_validate.py` checks the finished metadata (read-only, see Validation).

## Run end to end

```bash
cd /projects/bjey/worldtensor/scripts
J1=$(sbatch --parsable 01_download.sbatch)
J2=$(sbatch --parsable --dependency=afterok:$J1 02_extract.sbatch)
sbatch --dependency=afterok:$J2 03_build_manifest.sbatch
```

Step 03 submits the rest through `submit_chain.sh`: convert (`--array=0-N-1%64`), then pyramid with `afterok` on convert, then finalize with `afterok` on pyramid. Job IDs are saved in `.convert_job_id`, `.pyramid_job_id`, `.finalize_job_id`.

To rerun only the later stages on an existing manifest (for example after a code change), skip 01 to 03:

```bash
WT_STORE=/projects/bjey/worldtensor/zarr/worldtensor.zarr ./submit_chain.sh
```

04 and 05 retry up to three times each because 64 concurrent tasks can race on the shared uv cache (EBUSY). All store-writing steps overwrite their own group, so reruns are safe.

## Environment variables

| Variable | Default | Used by |
| --- | --- | --- |
| `WT_STORE` | `/projects/bjey/worldtensor/zarr/worldtensor.zarr` | 04, 05, 06, 08, 10, 11 (exported to jobs by `submit_chain.sh`) |
| `WT_MANIFEST` | `/projects/bjey/worldtensor/scripts/variables_manifest.jsonl` | 06, 08, 10, 11 |

04 and 05 take the manifest path and line index (`$SLURM_ARRAY_TASK_ID`) as arguments instead.

## Store layout

```
worldtensor.zarr/
  catalog.json
  <domain>/[<subgroup>/]<variable>/
    zarr.json          consolidated per group; proj:/spatial:/multiscales attrs
    spatial_ref/ lat/ lon/ [time/]
    <variable>/        base resolution (float32, NaN fill)
    2x/ 4x/ 8x/        pyramid levels, each a group with its own <variable>
    ts/                temporal variables only
```

| Array | Chunks |
| --- | --- |
| base | (1, 361, 360), one year per chunk |
| 2x | (1, ny, nx), one year, whole globe |
| 4x, 8x | (years, ny, nx), whole array in one chunk |
| ts | inner chunks (years, 16, 16), all in a single shard; one small range request per clicked pixel |

Static variables have no time dimension and no `ts`. All arrays use Zarr v3, float32, and `BytesCodec` followed by Blosc (zstd, level 9, byte shuffle, typesize 4), which is lossless. The Blosc codec is defined in both `04_convert.py` and `05_multiscale.py`; keep the two identical. Level 1x is the base grid (721 x 1440, cell centers, lon in [0, 360)); overview levels trim the odd trailing row/column, so every level stays an exact affine grid with coordinates in +-90.

## Validation

`09_validate.py [n_sample] [--store PATH] [--manifest PATH]` runs the official zarr-conventions v0.1 JSON schemas (`schemas/`) on every group, level and `ts`, checks each level's `spatial:transform` against its first and last coordinate, `|lat| <= 90`, `spatial:shape`, that rioxarray reads EPSG:4326, and the GDAL `GeoTransform` string. It never writes to the store and exits 1 on any error. A sample is a seeded random subset:

```bash
WT_STORE=/projects/bjey/worldtensor/zarr/worldtensor.zarr \
  uv run --with jsonschema --with xarray --with rioxarray --with zarr python3 -I 09_validate.py 15
```

## Upload to Source Cooperative

Target: `s3://tge-labs/worldtensor/worldtensor.zarr` via endpoint `https://data.source.coop`. Use the aws CLI. The proxy returns HTTP 413 for large single PUTs, so set a 32 MB multipart threshold, and disable the newer default checksums:

```bash
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
aws configure set default.s3.multipart_threshold 32MB
aws s3 sync /projects/bjey/worldtensor/zarr/worldtensor.zarr \
  s3://tge-labs/worldtensor/worldtensor.zarr --endpoint-url https://data.source.coop
```

`s5cmd` does not work against this endpoint (fails with "headers not signed").

## Development

Lint and type check from the repo root (`pyproject.toml` has the config; dev dependencies exist only so `ty` can resolve imports):

```bash
uv run --group dev ruff format pipeline
uv run --group dev ruff check pipeline
uv run --group dev ty check pipeline
```
