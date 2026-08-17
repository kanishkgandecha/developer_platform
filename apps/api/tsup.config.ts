import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle our own workspace packages (they ship as TS source, no separate
  // build step) but leave real npm dependencies — most importantly
  // @prisma/client, which relies on dynamic requires and a native query
  // engine binary that esbuild bundling breaks — external and resolved
  // normally from node_modules at runtime.
  noExternal: [/^@developer-platform\//],
  external: ["@prisma/client"],
});
