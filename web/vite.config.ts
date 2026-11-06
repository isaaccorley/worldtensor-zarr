import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

/**
 * Dev/preview only: serve a local zarr store at /data with HTTP Range support, so the
 * app reads it exactly as it will read Source Cooperative over HTTPS.
 *   WT_DATA=/projects/bjey/worldtensor/zarr/worldtensor_v2.zarr npm run dev
 */
function localZarr(root: string | undefined): Plugin {
  return {
    name: "local-zarr",
    configureServer(server) {
      if (root) server.middlewares.use("/data", serve);
    },
    configurePreviewServer(server) {
      if (root) server.middlewares.use("/data", serve);
    },
  };
  function serve(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!));
    if (rel.includes("..")) return next();
    const file = join(root!, rel);
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error();
      size = st.size;
    } catch {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "application/octet-stream");
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    if (!m) {
      res.setHeader("Content-Length", size);
      return createReadStream(file).pipe(res);
    }
    // suffix (bytes=-N) or offset range (bytes=a-b)
    const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    createReadStream(file, { start, end }).pipe(res);
  }
}

export default defineConfig({
  base: "./",
  plugins: [localZarr(process.env.WT_DATA)],
  server: { host: "127.0.0.1", port: 5173 },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
