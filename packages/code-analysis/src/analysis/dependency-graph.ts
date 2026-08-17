import { posix } from "node:path";
import type { DependencyEdge, ParsedFile } from "./types.js";

const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_SUFFIXES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs"];

function resolveRelativeImport(fromFile: string, specifier: string, knownPaths: ReadonlySet<string>): string | null {
  const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));

  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = suffix ? `${target}${suffix}` : target;
    if (knownPaths.has(candidate)) return candidate;
  }
  for (const suffix of INDEX_SUFFIXES) {
    const candidate = `${target}${suffix}`;
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Builds the repository's dependency graph from every file's already-parsed
 * imports (see parse-file.ts). Only TypeScript/JavaScript relative imports
 * (`./…`, `../…`) are resolved to a same-repository target file — plain
 * extension and `index` file resolution, no tsconfig path-alias resolution
 * (a deliberate, documented simplification: an alias-based import always
 * comes out `external: true`, same as a genuine npm package). Every import
 * from a heuristically-parsed language (Python/Java/C++/Go) is recorded as
 * a `CodeImport` but never resolved here — always `external: true` — since
 * none of those languages has a resolution algorithm implemented in Phase 4.
 */
export function buildDependencyGraph(files: readonly ParsedFile[]): DependencyEdge[] {
  const knownPaths = new Set(files.map((f) => f.path));
  const edges: DependencyEdge[] = [];

  for (const file of files) {
    // Only files that went through the real AST parser have imports whose
    // relative-path resolution rules we actually implement.
    const canResolve = file.parseStrategy === "ast";

    for (const imp of file.imports) {
      const isRelative = imp.source.startsWith("./") || imp.source.startsWith("../");
      const target = canResolve && isRelative ? resolveRelativeImport(file.path, imp.source, knownPaths) : null;

      edges.push({
        sourceFile: file.path,
        targetFile: target,
        external: target === null,
        kind: imp.kind,
        specifier: imp.source,
      });
    }
  }

  return edges;
}
