import type { AgentSpec } from "./types.js";

/**
 * The six primary agents' fixed definitions — a registry of data, not
 * seven independently-implemented functions (see `run-agent.ts`'s doc
 * comment). Order here is display/execution order (see
 * `@developer-platform/shared`'s `PRIMARY_AGENT_TYPES`), not a dependency
 * order — all six can run concurrently (bounded, see
 * apps/worker/src/ai-analysis/pipeline.ts).
 */
export const PRIMARY_AGENT_SPECS: readonly AgentSpec[] = [
  {
    type: "ARCHITECTURE",
    title: "Architecture Agent",
    focus:
      "You analyze this repository's software architecture: its major modules, application layers, service boundaries, dependency direction, and separation of concerns.",
    instructions: [
      "Identify the major modules and application layers present in the evidence",
      "Describe service/module boundaries you can actually observe",
      "Assess dependency direction and coupling between modules using the dependency evidence supplied",
      "Identify architectural patterns actually in use (not patterns you'd merely expect)",
      "Identify likely architectural risks — do not claim an architectural fact the evidence does not support",
    ],
    retrievalQuery: "module boundaries application layers service architecture entry points routing controllers",
  },
  {
    type: "CODE_QUALITY",
    title: "Code Quality Agent",
    focus:
      "You interpret code-quality issues already surfaced by deterministic static analysis, and prioritize them for engineering attention. You never invent a metric — every number you cite must come from the deterministic evidence supplied to you.",
    instructions: [
      "Explain the engineering impact of any high-complexity functions in the evidence",
      "Explain the impact of any oversized files in the evidence",
      "Explain the impact of long functions and functions with too many parameters",
      "Treat TODO/FIXME concentration as a signal of unfinished work, not a defect on its own",
      "Prioritize maintainability risks by likely engineering impact, most important first",
    ],
    severityGuidance: "Use the deterministic findings' own severities as your primary signal — do not re-derive or override a severity the deterministic analysis already assigned unless you have a clearly stated reason to differ.",
    retrievalQuery: "complex function long method large file duplicated logic",
    relevantRuleIds: ["COMPLEXITY_HIGH", "FILE_TOO_LARGE", "FUNCTION_TOO_LONG", "TOO_MANY_PARAMETERS", "TODO_COMMENT"],
  },
  {
    type: "SECURITY",
    title: "Security Agent",
    focus:
      "You identify likely security risks using static source-code analysis only. This is analysis, not penetration testing — you never execute code and never claim a pattern is definitely exploitable unless the evidence directly supports it.",
    instructions: [
      "Look for hardcoded secrets or credentials in the retrieved code",
      "Look for unsafe authentication or authorization patterns, or authorization gaps",
      "Look for insecure input handling",
      "Look for dangerous dynamic evaluation (eval, Function constructor, exec of arbitrary strings)",
      "Look for unsafe deserialization patterns",
      "Look for suspicious/unparameterized SQL string construction",
      "Look for unsafe command execution patterns",
      "Look for sensitive data exposure (secrets or tokens in logs, error messages, or responses)",
      "Look for insecure cryptographic usage (weak algorithms, hardcoded keys/IVs, disabled certificate validation)",
    ],
    severityGuidance:
      "Use CRITICAL/HIGH/MEDIUM/LOW/INFO. Do not claim a pattern is definitely exploitable unless the evidence directly supports it — use language like 'likely' or 'potential' where the evidence is suggestive rather than conclusive, and set your confidence accordingly lower in that case.",
    retrievalQuery: "authentication password secret token encryption sql query exec eval deserialize crypto hash",
  },
  {
    type: "PERFORMANCE",
    title: "Performance Agent",
    focus:
      "You identify likely performance bottlenecks from static evidence only. You never benchmark code and never claim a measured runtime result — you were only given source text, not a profiler.",
    instructions: [
      "Look for expensive loops or repeated work",
      "Look for N+1-like query patterns (a query issued inside a loop over another query's results)",
      "Look for excessive or repeated database calls",
      "Look for inefficient data transformations",
      "Look for evidence of large payloads being constructed or transferred",
      "Look for synchronous blocking patterns where asynchronous alternatives would be expected",
      "Look for inefficient algorithms or unnecessary recomputation",
    ],
    severityGuidance:
      "You are performing static analysis, not benchmarking. Never claim a measured runtime improvement — use language like 'likely bottleneck' or 'potential inefficiency', since your evidence is static, not measured.",
    retrievalQuery: "loop query database fetch map filter synchronous await promise cache recompute",
  },
  {
    type: "DEPENDENCY_RISK",
    title: "Dependency / Architecture Risk Agent",
    focus:
      "You analyze dependency relationships and structural risk using the repository's real, deterministic dependency graph evidence. You never invent a graph statistic — every fan-in/fan-out or coupling claim must trace back to the supplied evidence.",
    instructions: [
      "Identify highly coupled modules using the dependency evidence supplied",
      "Identify suspicious dependency directions (e.g. a lower-level module depending on a higher-level one)",
      "Identify central files with unusually high fan-in or fan-out, only where the evidence actually shows this",
      "Identify dependency concentration risk (many modules depending on one fragile file)",
      "Identify circular dependencies only where the supplied evidence actually shows one — never guess at a cycle",
    ],
    retrievalQuery: "import export module dependency require circular",
  },
  {
    type: "DOCUMENTATION",
    title: "Documentation / Maintainability Agent",
    focus:
      "You evaluate maintainability and developer experience: documentation coverage, naming clarity, and onboarding friction for a new engineer joining this codebase.",
    instructions: [
      "Identify missing documentation around genuinely complex areas (not every file needs a comment)",
      "Identify unclear naming only where the evidence actually supports it",
      "Treat TODO/FIXME concentration as an unfinished-documentation signal",
      "Identify public/exported APIs that lack any explanation of their purpose",
      "Identify areas likely to be difficult for a new developer to understand",
      "Do not penalize code simply for being concise — favor specific, actionable recommendations over generic advice",
    ],
    retrievalQuery: "public api exported function class interface documentation comment readme",
    relevantRuleIds: ["TODO_COMMENT", "FILE_TOO_LARGE", "COMPLEXITY_HIGH"],
  },
];
