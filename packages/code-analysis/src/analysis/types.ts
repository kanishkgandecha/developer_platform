/**
 * Normalized, framework-independent representation of a single parsed
 * source file — the shape every language parser (AST-based or heuristic)
 * produces, and everything downstream (metrics, rules, dependency
 * resolution, persistence) consumes. Mirrors Prisma's CodeSymbol/CodeImport
 * enums (packages/database/prisma/schema.prisma) without importing from
 * @prisma/client, for the same dependency-free reason as ../types.ts.
 */

export type SymbolKind =
  | "FUNCTION"
  | "METHOD"
  | "CLASS"
  | "INTERFACE"
  | "TYPE"
  | "ENUM"
  | "VARIABLE"
  | "CONSTANT"
  | "MODULE";

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  exported: boolean;
  /** Name of the enclosing symbol (e.g. a class for one of its methods), if any — resolved to a real id at persistence time. */
  parentName: string | null;
  /** A short, human-readable signature where cheaply available (e.g. `function foo(a: string): void`). Never the full body. */
  signature: string | null;
  /**
   * McCabe cyclomatic complexity, 1-based. Only computed for FUNCTION/METHOD
   * symbols parsed via a real AST (TypeScript/JavaScript) — `null`
   * everywhere else (see docs/code-intelligence.md's language support
   * table). Never estimated or guessed for languages without an AST.
   */
  complexity: number | null;
  /** Only meaningful for FUNCTION/METHOD; `null` for everything else. */
  parameterCount: number | null;
}

export type ImportKind = "IMPORT" | "REQUIRE" | "DYNAMIC_IMPORT" | "INCLUDE";

export interface ParsedImport {
  /** The raw specifier exactly as written — e.g. `"./services/github"`, `"fastify"`, `"os"`. Resolution into a same-repository target happens later, in dependency-graph.ts. */
  source: string;
  kind: ImportKind;
  /** 1-based. */
  line: number;
}

export type ParseStrategy = "ast" | "heuristic" | "none";

export interface ParsedFile {
  /** Relative path, matching RepositoryFile.path. */
  path: string;
  language: string;
  /**
   * `"ast"` — real AST-based parsing (TypeScript compiler API, currently
   * the only AST parser this phase ships).
   * `"heuristic"` — regex/line-based extraction for Python, Java, C++, Go.
   * Deliberately not a "fake AST": no tree is built or claimed, just
   * best-effort structured metadata extracted from source text. Documented
   * limitations in docs/code-intelligence.md.
   * `"none"` — language has no parser at all; metrics still get computed
   * (LOC/comments/blanks), symbols/imports are always empty.
   */
  parseStrategy: ParseStrategy;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
}

export interface CodeMetrics {
  lineCount: number;
  codeLineCount: number;
  commentLineCount: number;
  blankLineCount: number;
  functionCount: number;
  classCount: number;
  importCount: number;
  exportCount: number;
  /** Sum of every FUNCTION/METHOD symbol's complexity in the file. `null` when `parseStrategy !== "ast"` — never estimated. */
  complexity: number | null;
}

export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  /** Relative path of the file this finding is about. */
  file: string;
  /** 1-based, or `null` when the finding isn't tied to a specific line. */
  line: number | null;
  column: number | null;
  metadata: Record<string, unknown>;
}

export interface DependencyEdge {
  sourceFile: string;
  /** `null` when the import couldn't be resolved to a file in this repository (external package, or an unresolvable relative path). */
  targetFile: string | null;
  external: boolean;
  kind: ImportKind;
  /** The raw import specifier — for an external edge, this is effectively the package name. */
  specifier: string;
}

export interface RuleThresholds {
  complexityHigh: number;
  fileTooLargeLines: number;
  functionTooLongLines: number;
  tooManyParameters: number;
}

export const DEFAULT_RULE_THRESHOLDS: RuleThresholds = {
  complexityHigh: 10,
  fileTooLargeLines: 500,
  functionTooLongLines: 80,
  tooManyParameters: 5,
};

export interface AnalysisContext {
  file: ParsedFile;
  metrics: CodeMetrics;
  content: string;
  thresholds: RuleThresholds;
}

/**
 * A deterministic, self-contained static-analysis rule. No AI, no network
 * access, no shared mutable state between rules — see rules/rule-engine.ts.
 */
export interface AnalysisRule {
  id: string;
  description: string;
  run(context: AnalysisContext): Finding[];
}
