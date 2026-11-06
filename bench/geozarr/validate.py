"""Validate GeoZarr metadata: official zarr-conventions v0.1 JSON schemas,
transform <-> coordinate consistency per level, rioxarray CRS round trip.
Usage: validate.py <store> <manifest.jsonl> [n_sample]"""
import json, os, random, sys
import jsonschema, numpy as np, xarray as xr, rioxarray  # noqa: F401
HERE = os.path.dirname(os.path.abspath(__file__))
store, manifest = sys.argv[1], sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 10**9
schemas = {k: json.load(open(f"{HERE}/{k}.schema.json")) for k in ("multiscales", "spatial", "proj")}
groups = [json.loads(l)["group_path"] for l in open(manifest)]
random.seed(0); groups = groups if len(groups) <= n else random.sample(groups, n)
errors, checked = [], 0
def meta(p): return json.load(open(os.path.join(store, p, "zarr.json")))
for g in groups:
    m = meta(g); a = m["attributes"]
    for k in ("multiscales", "spatial", "proj"):
        try: jsonschema.validate(m, schemas[k])
        except jsonschema.ValidationError as e: errors.append(f"{g} [{k}] {e.message[:160]}")
    for item in a["multiscales"]["layout"]:
        lvl_group = g if "/" not in item["asset"] else f"{g}/{item['asset'].split('/')[0]}"
        lm = meta(lvl_group)
        if lvl_group != g:
            for k in ("spatial", "proj"):
                try: jsonschema.validate(lm, schemas[k])
                except jsonschema.ValidationError as e: errors.append(f"{lvl_group} [{k}] {e.message[:160]}")
        ds = xr.open_zarr(os.path.join(store, lvl_group), consolidated=False)
        A, _, c, _, e, f = item["spatial:transform"]
        lon0, lat0 = c + 0.5 * A, f + 0.5 * e
        if not (np.isclose(ds.lon.values[0], lon0) and np.isclose(ds.lat.values[0], lat0)):
            errors.append(f"{lvl_group}: centre of (0,0) {lon0},{lat0} != coords {ds.lon.values[0]},{ds.lat.values[0]}")
        ny, nx = ds.sizes["lat"], ds.sizes["lon"]
        lonN, latN = c + (nx - 0.5) * A, f + (ny - 0.5) * e
        if not (np.isclose(ds.lon.values[-1], lonN) and np.isclose(ds.lat.values[-1], latN)):
            errors.append(f"{lvl_group}: centre of last cell {lonN},{latN} != coords {ds.lon.values[-1]},{ds.lat.values[-1]}")
        if np.abs(ds.lat.values).max() > 90:
            errors.append(f"{lvl_group}: |lat| > 90")
        if list(item["spatial:shape"]) != [ny, nx]:
            errors.append(f"{lvl_group}: spatial:shape mismatch")
        var = item["asset"].split("/")[-1]
        crs = ds[var].rio.crs
        if crs is None or crs.to_epsg() != 4326: errors.append(f"{lvl_group}: rio.crs={crs}")
        gt = ds["spatial_ref"].attrs.get("GeoTransform", "")
        if [float(x) for x in gt.split()] != [c, A, 0.0, f, 0.0, e]: errors.append(f"{lvl_group}: GeoTransform {gt!r}")
        checked += 1
    if "ts" in [k for k in os.listdir(os.path.join(store, g))]:
        try: jsonschema.validate(meta(f"{g}/ts"), schemas["spatial"]); jsonschema.validate(meta(f"{g}/ts"), schemas["proj"])
        except jsonschema.ValidationError as e: errors.append(f"{g}/ts {e.message[:160]}")
print(f"variables={len(groups)} levels_checked={checked} errors={len(errors)}")
print("\n".join(errors[:25]))
sys.exit(1 if errors else 0)
