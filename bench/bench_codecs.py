"""Benchmark compressed size + decode time for one time slice of several
WorldTensor variables under candidate codec / chunk configs."""
import time

import numcodecs
import numpy as np
import xarray as xr
from numcodecs import Blosc, Zstd

STORE = "/projects/bjey/worldtensor/zarr/worldtensor.zarr"
VARS = [
    "climate/t2m_mean",
    "climate/tp_sum",
    "ocean/chl_max",
    "land_use/states/secdf",
    "human_systems/ghsl_built_surface",
    "static/soil_properties/bdod_0-5cm_mean",
]


def bitround(a, keepbits):
    b = a.copy().view(np.uint32)
    drop = 23 - keepbits
    half = np.uint32(1 << (drop - 1))
    mask = np.uint32((0xFFFFFFFF >> drop) << drop)
    out = ((b + half) & mask).view(np.float32)
    out[~np.isfinite(a)] = np.nan
    return out


CODECS = {
    "zstd5 (current)": lambda a: (Zstd(5), a),
    "blosc-zstd5+shuffle": lambda a: (Blosc("zstd", 5, Blosc.SHUFFLE), a),
    "bitround12+blosc-zstd": lambda a: (Blosc("zstd", 5, Blosc.SHUFFLE), bitround(a, 12)),
    "bitround8+blosc-zstd": lambda a: (Blosc("zstd", 5, Blosc.SHUFFLE), bitround(a, 8)),
    "float16+zstd5": lambda a: (Zstd(5), a.astype(np.float16)),
}


def chunks(a, shape):
    h, w = shape
    for y in range(0, a.shape[0], h):
        for x in range(0, a.shape[1], w):
            yield np.ascontiguousarray(a[y : y + h, x : x + w])


def main():
    for g in VARS:
        ds = xr.open_zarr(STORE, group=g, consolidated=False)
        (v,) = [k for k in ds.data_vars if k != "spatial_ref"]
        da = ds[v]
        a = (da.isel(time=-1) if "time" in da.dims else da).values.astype(np.float32)
        nan = np.isnan(a).mean()
        rng = np.nanmax(np.abs(a)) or 1
        print(f"\n== {g}  shape={a.shape} nan={nan:.0%} raw={a.nbytes/1e6:.1f}MB")
        for name, fn in CODECS.items():
            codec, data = fn(a)
            for cs in [(721, 1440), (256, 256)]:
                bufs = [codec.encode(c) for c in chunks(data, cs)]
                tot = sum(len(b) for b in bufs)
                t0 = time.perf_counter()
                for _ in range(5):
                    for b in bufs:
                        codec.decode(b)
                dt = (time.perf_counter() - t0) / 5 * 1e3
                err = np.nanmax(np.abs(data.astype(np.float32) - a)) / rng
                print(f"  {name:24s} chunk={cs!s:12s} n={len(bufs):3d} {tot/1e6:6.2f}MB "
                      f"ratio={a.nbytes/tot:4.1f}x decode={dt:5.1f}ms relerr={err:.1e}")


if __name__ == "__main__":
    print("numcodecs", numcodecs.__version__)
    main()
