import type { ExplainMode } from '../contracts';
import type { ModelCapabilities } from './capabilities';

/**
 * `max_completion_tokens` per mode: the ONE table to tune (decision D-09, Spike A follow-up).
 *
 * `standard` is for models that answer directly; `reasoning` is for models that think first
 * (gpt-oss, qwen3), because their reasoning tokens count against the same limit and a budget
 * that is too small cuts the JSON off (`finish_reason: length` -> INVALID_RESPONSE). A budget
 * is a ceiling, not a spend: only tokens actually generated are billed.
 *
 * PLACEHOLDERS, sized from the contract's output bounds (lib/contracts/explain.ts) with
 * generous headroom, NOT from measurements. Replace them with the means from the user's run of
 * scripts/eval/explain-eval.ts (docs/decisions/p5-prompt-eval.md): about 1.5x the p95
 * completion tokens (reasoning included) per mode and model class. `simplify` and `translate`
 * scale with the selection (up to 2,000 characters, and CJK text costs more tokens per
 * character), hence their larger ceilings.
 */
export interface TokenBudget {
  standard: number;
  reasoning: number;
}

export const MODE_TOKEN_BUDGETS: Readonly<Record<ExplainMode, TokenBudget>> = {
  core: { standard: 1024, reasoning: 2048 },
  etymology: { standard: 700, reasoning: 1800 },
  related_words: { standard: 400, reasoning: 1200 },
  simplify: { standard: 1500, reasoning: 3000 },
  grammar: { standard: 900, reasoning: 2000 },
  translate: { standard: 2000, reasoning: 3500 },
};

/** The completion budget for a mode on a model class. */
export function maxCompletionTokensFor(
  mode: ExplainMode,
  capabilities: Pick<ModelCapabilities, 'reasoning'>,
): number {
  const budget = MODE_TOKEN_BUDGETS[mode];
  return capabilities.reasoning ? budget.reasoning : budget.standard;
}
