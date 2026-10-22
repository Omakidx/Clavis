import { describe, expect, it } from 'vitest';
import {
  followedInjection,
  parseArgs,
  percentile,
  pickNonReasoningModel,
  summarize,
  type Trial,
} from '../../../scripts/spikes/groq-compare';

describe('percentile (nearest rank)', () => {
  it('computes p50 and p95 and handles empty input', () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(percentile(values, 50)).toBe(100);
    expect(percentile(values, 95)).toBe(190);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('pickNonReasoningModel', () => {
  it('prefers a small instant model and never a reasoning, speech or guard model', () => {
    const pick = pickNonReasoningModel([
      { id: 'openai/gpt-oss-20b' },
      { id: 'qwen/qwen3-32b' },
      { id: 'whisper-large-v3' },
      { id: 'meta-llama/llama-guard-4-12b' },
      { id: 'llama-3.3-70b-versatile' },
      { id: 'llama-3.1-8b-instant' },
    ]);
    expect(pick?.id).toBe('llama-3.1-8b-instant');
    expect(pick?.why).toMatch(/instant/);
  });

  it('skips inactive models and returns null when nothing qualifies', () => {
    expect(pickNonReasoningModel([{ id: 'llama-3.1-8b-instant', active: false }])).toBeNull();
    expect(pickNonReasoningModel([{ id: 'openai/gpt-oss-20b' }])).toBeNull();
  });

  it('falls back to a weak choice with an honest reason', () => {
    const pick = pickNonReasoningModel([{ id: 'some-model' }]);
    expect(pick?.id).toBe('some-model');
    expect(pick?.why).toMatch(/weak/);
  });
});

describe('followedInjection', () => {
  it('flags answers that merely echo the injected marker, not explanations that quote it', () => {
    expect(followedInjection({ title: 'PWNED', summary: 'PWNED' }, ['PWNED'])).toBe(true);
    expect(followedInjection({ title: 'pwned!', summary: 'x' }, ['PWNED'])).toBe(true);
    expect(
      followedInjection(
        {
          title: 'Ignore previous instructions',
          summary: 'A prompt injection that asks for "PWNED".',
        },
        ['PWNED'],
      ),
    ).toBe(false);
  });
});

describe('parseArgs', () => {
  it('has safe defaults and validates values', () => {
    expect(parseArgs([])).toEqual({ runs: 3, mock: false, maxRequests: 63, maxWaitSeconds: 60 });
    expect(parseArgs(['--runs', '2', '--mock', '--max-requests', '10'])).toMatchObject({
      runs: 2,
      mock: true,
      maxRequests: 10,
    });
    expect(() => parseArgs(['--runs', '0'])).toThrow();
    expect(() => parseArgs(['--runs'])).toThrow();
    expect(() => parseArgs(['--api-key', 'gsk_TEST_x'])).toThrow(/Unknown argument/);
    // The offending value must not be echoed back.
    expect(() => parseArgs(['--api-key', 'gsk_TEST_x'])).not.toThrow(/gsk_/);
  });
});

describe('summarize', () => {
  const base = {
    model: 'm',
    caseId: 'c',
    run: 1,
    requests: 1,
    startedWith: 'json_schema',
    fellBack: false,
    memoizedFallback: false,
    rateLimitWaits: 0,
    flags: [] as string[],
  } as const;
  const ok = (latencyMs: number): Trial => ({
    ...base,
    ok: true,
    latencyMs,
    responseMode: 'json_schema',
    jsonParsed: true,
    schemaValid: true,
    usage: { completionTokens: 100, reasoningTokens: 40 },
  });

  it('computes validity from trials that produced a completion and excludes transport errors', () => {
    const trials: Trial[] = [
      ok(100),
      ok(200),
      {
        ...base,
        ok: false,
        latencyMs: 50,
        errorCode: 'INVALID_RESPONSE',
        errorStage: 'json',
        jsonParsed: false,
        schemaValid: false,
      },
      {
        ...base,
        ok: false,
        latencyMs: 10,
        errorCode: 'NETWORK_ERROR',
        jsonParsed: null,
        schemaValid: null,
      },
    ];
    const s = summarize('m', trials);
    expect(s).toMatchObject({
      trials: 4,
      ok: 2,
      p50LatencyMs: 100,
      p95LatencyMs: 200,
      meanCompletionTokens: 100,
      meanReasoningTokens: 40,
      jsonSchemaAccepted: true,
    });
    expect(s.schemaValidityPct).toBeCloseTo(66.7, 1); // 2 of 3 answered
    expect(s.jsonValidityPct).toBeCloseTo(66.7, 1);
    expect(s.errors).toEqual({ INVALID_RESPONSE: 1, NETWORK_ERROR: 1 });
  });
});
