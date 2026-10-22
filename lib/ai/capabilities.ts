/**
 * Small, explicit model capability table (architecture §6: "verify model-specific support").
 *
 * Source: Groq docs (structured-outputs, reasoning) consulted 2026-10-22. Anything not
 * listed gets conservative defaults: no `reasoning_effort`, best-effort JSON schema. Spike A
 * records what the account's models actually accept; update this table from the results.
 */

export type JsonSchemaSupport = 'strict' | 'best_effort' | 'unknown';

export interface ModelCapabilities {
  /** Value sent as `reasoning_effort`, or null when the model is not known to accept it. */
  reasoningEffort: 'low' | null;
  /** Documented `response_format: json_schema` support level. */
  jsonSchema: JsonSchemaSupport;
  /** Completion budget when the caller gives none. Reasoning tokens count against it. */
  defaultMaxCompletionTokens: number;
}

interface CapabilityRule {
  pattern: RegExp;
  capabilities: ModelCapabilities;
}

const RULES: readonly CapabilityRule[] = [
  {
    // gpt-oss 20B/120B: reasoning_effort low|medium|high, strict structured outputs.
    pattern: /^openai\/gpt-oss-(?:20b|120b)$/,
    capabilities: {
      reasoningEffort: 'low',
      jsonSchema: 'strict',
      defaultMaxCompletionTokens: 2048,
    },
  },
  {
    // Other gpt-oss variants (e.g. safeguard): same effort values, best-effort schema only.
    pattern: /^openai\/gpt-oss/,
    capabilities: {
      reasoningEffort: 'low',
      jsonSchema: 'best_effort',
      defaultMaxCompletionTokens: 2048,
    },
  },
  {
    // Documented strict-schema models that do NOT take gpt-oss style effort values.
    pattern: /^(?:qwen\/qwen3|meta-models\/muse-spark)/,
    capabilities: { reasoningEffort: null, jsonSchema: 'strict', defaultMaxCompletionTokens: 2048 },
  },
];

const DEFAULTS: ModelCapabilities = {
  reasoningEffort: null,
  jsonSchema: 'unknown',
  defaultMaxCompletionTokens: 1024,
};

export function getModelCapabilities(modelId: string): ModelCapabilities {
  return RULES.find((rule) => rule.pattern.test(modelId))?.capabilities ?? DEFAULTS;
}

/** Models that are not text-chat models (speech, safety classifiers, embeddings). */
const NON_CHAT_PATTERN = /whisper|tts|orpheus|playai|guard|safeguard|embed|moderation|transcri/i;

/** Heuristic: could this model id serve a text chat completion? */
export function isTextChatModel(modelId: string): boolean {
  return !NON_CHAT_PATTERN.test(modelId);
}
