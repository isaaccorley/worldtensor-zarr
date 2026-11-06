import time, numpy as np, xarray as xr
from numcodecs import Blosc, Zstd
S="/projects/bjey/worldtensor/zarr/worldtensor.zarr"
C={"zstd5":Zstd(5),"blosc-zstd5-shuf":Blosc("zstd",5,Blosc.SHUFFLE),"blosc-zstd5-bitshuf":Blosc("zstd",5,Blosc.BITSHUFFLE),
   "blosc-zstd9-shuf":Blosc("zstd",9,Blosc.SHUFFLE),"blosc-lz4-shuf":Blosc("lz4",5,Blosc.SHUFFLE)}
for g in ["climate/t2m_mean","climate/tp_sum","ocean/chl_max","human_systems/ghsl_built_surface"]:
    ds=xr.open_zarr(S,group=g,consolidated=False); v=[k for k in ds.data_vars if k!="spatial_ref"][0]
    a=np.ascontiguousarray(ds[v].isel(time=-1).values)
    for n,c in C.items():
        t0=time.perf_counter(); b=c.encode(a); te=time.perf_counter()-t0
        t0=time.perf_counter(); [c.decode(b) for _ in range(5)]; td=(time.perf_counter()-t0)/5
        print(f"{g:34s} {n:20s} {len(b)/1e6:5.2f}MB enc={te*1e3:5.0f}ms dec={td*1e3:4.1f}ms")
