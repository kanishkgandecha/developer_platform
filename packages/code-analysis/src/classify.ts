import { languageForExtension } from "./language-map.js";
import type { FileCategory, FileClassification } from "./types.js";

/** Exact filename matches, checked before extension rules (e.g. `package.json` is CONFIG, not generic DATA). */
const CONFIG_FILENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".prettierrc",
  ".prettierrc.json",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Makefile",
  ".gitignore",
  ".dockerignore",
  ".npmrc",
  ".env.example",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "vite.config.ts",
  "tailwind.config.ts",
  "turbo.json",
  "pnpm-workspace.yaml",
  "Gemfile",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

const DOCUMENTATION_FILENAMES: ReadonlySet<string> = new Set([
  "README",
  "README.MD",
  "LICENSE",
  "LICENSE.MD",
  "CHANGELOG",
  "CHANGELOG.MD",
  "CONTRIBUTING",
  "CONTRIBUTING.MD",
  "AUTHORS",
  "NOTICE",
  "CODE_OF_CONDUCT",
  "CODE_OF_CONDUCT.MD",
]);

/** Lockfiles: dependency-manager-generated, never hand-written. */
const GENERATED_FILENAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
]);

const DOCUMENTATION_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx", ".rst", ".txt"]);
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf"]);
const DATA_EXTENSIONS: ReadonlySet<string> = new Set([".json", ".csv", ".tsv", ".xml", ".svg"]);
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp",
  // fonts
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  // archives
  ".zip", ".tar", ".gz", ".rar", ".7z",
  // compiled/executable
  ".exe", ".dll", ".so", ".dylib", ".o", ".class", ".jar", ".war", ".pyc",
  // media
  ".mp3", ".mp4", ".mov", ".avi", ".wav",
  // documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  // databases
  ".db", ".sqlite",
]);

function isGeneratedByPattern(name: string): boolean {
  return name.endsWith(".min.js") || name.endsWith(".min.css") || name.endsWith(".map");
}

/**
 * Classifies a single discovered file by name/extension only — "extension-
 * based detection with a centralized mapping," not content sniffing. Every
 * new category/extension goes in exactly one of the sets/maps above.
 */
export function classifyFile(fileName: string, extension: string): FileClassification {
  const ext = extension.toLowerCase();

  if (GENERATED_FILENAMES.has(fileName) || isGeneratedByPattern(fileName)) {
    return build("GENERATED", null);
  }

  if (DOCUMENTATION_FILENAMES.has(fileName.toUpperCase())) {
    return build("DOCUMENTATION", null);
  }

  if (CONFIG_FILENAMES.has(fileName)) {
    return build("CONFIG", null);
  }

  const language = languageForExtension(ext);
  if (language) {
    return build("SOURCE", language);
  }

  if (DOCUMENTATION_EXTENSIONS.has(ext)) return build("DOCUMENTATION", null);
  if (CONFIG_EXTENSIONS.has(ext)) return build("CONFIG", null);
  if (BINARY_EXTENSIONS.has(ext)) return build("BINARY", null);
  if (DATA_EXTENSIONS.has(ext)) return build("DATA", null);

  // Unknown extension (or none) — counted, not silently dropped, but not
  // treated as source either. Conservative default, easy to refine later.
  return build("DATA", null);
}

function build(category: FileCategory, language: string | null): FileClassification {
  return {
    category,
    language,
    isSource: category === "SOURCE",
    isIgnored: category === "IGNORED",
  };
}
