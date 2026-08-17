import ts from "typescript";
import { extname } from "node:path";
import { languageForExtension } from "../language-map.js";
import type { ImportKind, ParsedFile, ParsedImport, ParsedSymbol, SymbolKind } from "./types.js";

/**
 * Real AST-based parsing for TypeScript/JavaScript via the TypeScript
 * compiler API (`ts.createSourceFile` + a manual tree walk) — the only
 * language in Phase 4 that gets a genuine AST rather than heuristic
 * extraction (see heuristic-parser.ts and docs/code-intelligence.md).
 * Never type-checks (no `ts.createProgram`, no `.d.ts`/`node_modules`
 * resolution) — this is syntax-only structural extraction, which is all
 * that's needed for symbols/imports/complexity and keeps parsing a single
 * file genuinely independent of the rest of the repository.
 */

function scriptKindForPath(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** Node kinds that add one decision path each — the standard McCabe cyclomatic-complexity approximation (baseline 1 + one per branch). */
const DECISION_POINT_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
]);

const SHORT_CIRCUITING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Complexity of `fnNode` alone — a nested function-like node stops descent, since it gets counted separately as its own symbol. */
function countComplexity(fnNode: ts.Node): number {
  let count = 1;
  function visit(node: ts.Node): void {
    if (node !== fnNode && isFunctionLike(node)) {
      return;
    }
    if (DECISION_POINT_KINDS.has(node.kind)) {
      count += 1;
    }
    if (ts.isBinaryExpression(node) && SHORT_CIRCUITING_OPERATORS.has(node.operatorToken.kind)) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(fnNode, visit);
  return count;
}

function propertyNameToString(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null; // computed property name (e.g. `[Symbol.iterator]`) — not tracked as a named symbol
}

function functionSignature(name: string, node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile): string {
  const params = node.parameters.map((p) => p.name.getText(sourceFile)).join(", ");
  return `${name}(${params})`;
}

function isExported(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  ) ?? false;
}

export function parseTypeScript(path: string, content: string): ParsedFile {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForPath(path));
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];

  const lineOf = (pos: number): number => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  function recordImport(source: string, kind: ImportKind, pos: number): void {
    imports.push({ source, kind, line: lineOf(pos) });
  }

  function recordSymbol(
    name: string,
    kind: SymbolKind,
    node: ts.Node,
    opts: {
      exported?: boolean;
      parentName?: string | null;
      signature?: string | null;
      complexity?: number | null;
      parameterCount?: number | null;
    } = {},
  ): void {
    symbols.push({
      name,
      kind,
      startLine: lineOf(node.getStart(sourceFile)),
      endLine: lineOf(node.getEnd()),
      exported: opts.exported ?? isExported(node),
      parentName: opts.parentName ?? null,
      signature: opts.signature ?? null,
      complexity: opts.complexity ?? null,
      parameterCount: opts.parameterCount ?? null,
    });
  }

  /** Finds require()/dynamic import() calls nested anywhere inside `node` — used for initializers `visit` otherwise doesn't descend into (see the VariableStatement branch). */
  function scanForInlineImports(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const requireArg = node.arguments.length === 1 ? node.arguments[0] : undefined;
      if (requireArg && ts.isStringLiteral(requireArg)) {
        recordImport(requireArg.text, "REQUIRE", node.getStart(sourceFile));
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        recordImport(arg.text, "DYNAMIC_IMPORT", node.getStart(sourceFile));
      }
    }
    ts.forEachChild(node, scanForInlineImports);
  }

  function visit(node: ts.Node, parentName: string | null): void {
    // import "x"; import { y } from "x";
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        recordImport(node.moduleSpecifier.text, "IMPORT", node.getStart(sourceFile));
      }
      return;
    }

    // export { y } from "x"; export * from "x";
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      recordImport(node.moduleSpecifier.text, "IMPORT", node.getStart(sourceFile));
      return;
    }

    // require("x")
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const requireArg = node.arguments.length === 1 ? node.arguments[0] : undefined;
      if (requireArg && ts.isStringLiteral(requireArg)) {
        recordImport(requireArg.text, "REQUIRE", node.getStart(sourceFile));
      }
    }

    // import("x") — dynamic import
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        recordImport(arg.text, "DYNAMIC_IMPORT", node.getStart(sourceFile));
      }
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      recordSymbol(name, "CLASS", node, { parentName, signature: `class ${name}` });
      ts.forEachChild(node, (child) => visit(child, name));
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      recordSymbol(name, "INTERFACE", node, { parentName, signature: `interface ${name}` });
      return; // members aren't modeled as separate symbols
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      recordSymbol(name, "TYPE", node, { parentName, signature: `type ${name}` });
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      const name = node.name.text;
      recordSymbol(name, "ENUM", node, { parentName, signature: `enum ${name}` });
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      recordSymbol(name, "FUNCTION", node, {
        parentName,
        signature: functionSignature(name, node, sourceFile),
        complexity: countComplexity(node),
        parameterCount: node.parameters.length,
      });
      ts.forEachChild(node, (child) => visit(child, parentName));
      return;
    }

    if (ts.isConstructorDeclaration(node) && parentName) {
      recordSymbol("constructor", "METHOD", node, {
        parentName,
        signature: `constructor(${node.parameters.length} params)`,
        complexity: countComplexity(node),
        parameterCount: node.parameters.length,
      });
      ts.forEachChild(node, (child) => visit(child, parentName));
      return;
    }

    if (ts.isMethodDeclaration(node) && parentName) {
      const name = propertyNameToString(node.name);
      if (name) {
        recordSymbol(name, "METHOD", node, {
          parentName,
          signature: functionSignature(name, node, sourceFile),
          complexity: countComplexity(node),
          parameterCount: node.parameters.length,
        });
      }
      ts.forEachChild(node, (child) => visit(child, parentName));
      return;
    }

    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          const initializer = decl.initializer;
          if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
            recordSymbol(name, parentName ? "METHOD" : "FUNCTION", node, {
              exported,
              parentName,
              signature: functionSignature(name, initializer, sourceFile),
              complexity: countComplexity(initializer),
              parameterCount: initializer.parameters.length,
            });
          } else {
            recordSymbol(name, isConst ? "CONSTANT" : "VARIABLE", node, { exported, parentName });
          }
        }
        // Not otherwise descending into the declaration (keeps top-level
        // extraction focused, not noisy) — but a bound initializer like
        // `const legacy = require("./legacy")` or an arrow function body
        // that itself calls require()/import() still needs to surface as
        // an import, so scan just for those two call shapes specifically.
        if (decl.initializer) scanForInlineImports(decl.initializer);
      }
      return;
    }

    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      recordSymbol(name, "MODULE", node, { parentName });
      ts.forEachChild(node, (child) => visit(child, name));
      return;
    }

    ts.forEachChild(node, (child) => visit(child, parentName));
  }

  visit(sourceFile, null);

  return {
    path,
    language: languageForExtension(extname(path)) ?? "TypeScript",
    parseStrategy: "ast",
    symbols,
    imports,
  };
}
