# worldtensor

NetCDF -> GeoZarr conversion, multiscale pyramids, and a visualization webapp
for [WorldTensor](https://arxiv.org/abs/2607.03298), a harmonized Earth system
dataset ([Zenodo](https://zenodo.org/records/19047618)).

## Pipeline

Runs on the RAILS cluster via SLURM, chained end to end with job dependencies:

1. `01_download.sbatch` — fetch the 14 Zenodo zip archives (48.5 GB), checksum-verified
2. `02_extract.sbatch` — unzip each domain to `raw/netcdf/<domain>/...`
3. `03_build_manifest.py` / `.sbatch` — enumerate every (domain, variable) unit, then
   self-submits the remaining stages sized to the manifest
4. `04_convert.py` / `.sbatch` — convert each variable to a self-contained GeoZarr
   group (own lat/lon/time coords, CF-1.8 `spatial_ref`) in a single
   `worldtensor.zarr` store
5. `05_multiscale.py` / `.sbatch` — cascaded halving pyramid per variable, resampling
   chosen by semantics (`sum`/`mode`/`average`), plus a `ts` pixel-time-series array
6. `06_finalize.sbatch` — per-group metadata consolidation (`06_consolidate.py`) and
   `catalog.json` for the web viewer (`08_catalog.py`)

`submit_chain.sh` submits stages 4-6; `WT_STORE` selects the output store.
Working data lives on `/projects/bjey/worldtensor` (not in git).

## Store layout

Tuned for a static browser app reading over HTTPS range requests
(see `bench/` for the measurements behind these choices).

| array | chunks | why |
|---|---|---|
| `<var>/<var>` (base, 721x1440) | 1 year x 361x360 (2x4 tiles) | regional zoom fetches only visible tiles |
| `<var>/2x/<var>` | 1 year x whole globe | global view = 1 request |
| `<var>/{4x,8x,16x}/<var>` | all years x whole globe | time slider / animation = 1 request |
| `<var>/ts/<var>` | (all years, 64, 64) inner chunks, one shard | pixel time series = 1 small range read |

- Codec: lossless blosc zstd level 9 + byte shuffle (float32, NaN fill).
- No root consolidated metadata (would be ~24 MB); each variable group is
  consolidated, so `xr.open_zarr(f"{store}/{group}")` is one request.
- `catalog.json` at the store root lists every variable's units, years, array
  shapes/chunks and p2/p98 color range; the viewer synthesizes each array's
  `zarr.json` from it plus `array_template`, so it makes no metadata requests.
- Grid: EPSG:4326 cell centers, lat ascending (-90..90), lon 0..359.75.

## Viewer (`web/`)

Static Vite + TypeScript app: MapLibre globe + deck.gl `ZarrLayer`
([deck.gl-raster](https://github.com/developmentseed/deck.gl-raster)) reading the
store straight over HTTP range requests — no tile server.

```bash
cd web && npm install
WT_DATA=/projects/bjey/worldtensor/zarr/worldtensor_v2.zarr npm run dev   # serves the store at /data
VITE_DATA_URL=https://data.source.coop/taylor-geospatial/<repo>/worldtensor.zarr npm run build
```

- Two layers per variable: an *overview* on the 8x/16x levels (every year in one
  Texture2DArray, so play/scrub is a uniform change with zero requests) and a
  *detail* layer on base/2x that fetches only the shown year once it settles.
- `ViewerStore` answers every pyramid `zarr.json` from `catalog.json` (zero
  metadata round trips), dedupes in-flight requests and LRU-caches chunk bytes.
- Hover = exact pixel point query against cached chunks; click = full time
  series from the sharded `ts` array, with a per-decade OLS trend.
- The grid is stored south-up (lat ascending), which mirrors mesh winding on the
  globe; layers cull *front* faces (see `layers.ts`).

## Status

Conversion pipeline running. Next: local viz webapp, then rehost the zarr store
to Source Cooperative (`taylor-geospatial` org) and switch the webapp to HTTPS
range requests against it.
