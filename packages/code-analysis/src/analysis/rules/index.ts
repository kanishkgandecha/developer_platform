import type { AnalysisRule } from "../types.js";
import { complexityHighRule } from "./complexity-high.js";
import { fileTooLargeRule } from "./file-too-large.js";
import { functionTooLongRule } from "./function-too-long.js";
import { todoCommentRule } from "./todo-comment.js";
import { tooManyParametersRule } from "./too-many-parameters.js";

export * from "./rule-engine.js";
export * from "./complexity-high.js";
export * from "./file-too-large.js";
export * from "./function-too-long.js";
export * from "./too-many-parameters.js";
export * from "./todo-comment.js";

/** Every deterministic rule Phase 4 ships, in the order findings are produced. No AI, no network access — see docs/code-intelligence.md. */
export const DEFAULT_RULES: readonly AnalysisRule[] = [
  complexityHighRule,
  fileTooLargeRule,
  functionTooLongRule,
  tooManyParametersRule,
  todoCommentRule,
];
