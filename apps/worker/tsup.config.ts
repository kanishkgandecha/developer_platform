import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle our own workspace packages (they ship as TS source, no separate
  // build step). @prisma/client stays external for the same reason as
  // apps/api (see its tsup.config.ts). Phase 4: @developer-platform/code-analysis
  // uses the `typescript` compiler API at runtime (real TS/JS AST parsing,
  // not just a build-time devDependency) — bundling the whole compiler
  // would be wasteful and risky (it's a large, actively-versioned package),
  // so it stays external and resolves normally from node_modules instead.
  noExternal: [/^@developer-platform\//],
  external: ["@prisma/client", "typescript"],
});
