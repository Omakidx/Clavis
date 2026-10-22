/**
 * Spike A model comparison (decision D-09).
 *
 *   GROQ_API_KEY=... npx tsx scripts/spikes/groq-compare.ts [--runs 3] [--mock]
 *
 * Runs the `core` prompt on the semantic fixtures against openai/gpt-oss-20b,
 * openai/gpt-oss-120b (when listed) and one fast non-reasoning text model, through
 * lib/ai, and writes a JSON + Markdown report to docs/decisions/spike-a-results/.
 *
 * Secret handling: the key is read ONLY from process.env.GROQ_API_KEY, kept in one local
 * variable, and never printed, logged or written. Errors are reported by code only.
 * `--mock` uses an offline fake fetch (and ignores the environment key entirely).
 *
 * Flags:
 *   --runs N                  repetitions per model x case (default 3)
 *   --max-requests N          hard cap on HTTP requests, fallbacks and 429 retries included (default 63)
 *   --max-wait-seconds N      longest Retry-After honoured; a longer one stops the run (default 60)
 *   --max-completion-tokens N override the per-model default completion budget
 *   --mock                    offline run with a built-in fake API; no key needed
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GroqError,
  GroqProvider,
  getModelCapabilities,
  isTextChatModel,
  type ExplainDetails,
  type GroqModel,
  type GroqUsage,
  type InvalidResponseStage,
  type ResponseMode,
} from '../../lib/ai';
import { explainRequestSchema, type ExplainRequest } from '../../lib/contracts';
import { createMockFetch } from './fixtures/mock-groq';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CoreCase {
  id: string;
  label: string;
  review: boolean;
  snapshot: Record<string, unknown>;
  targetLanguage?: string;
  injectionMarkers?: string[];
  humanCheck: string;
}

export interface Options {
  runs: number;
  mock: boolean;
  maxRequests: number;
  maxWaitSeconds: number;
  maxCompletionTokens?: number;
}

interface AnswerRecord {
  title: string;
  summary: string;
  contextualMeaning?: string;
  definition?: string;
  examples?: { sentence: string; note?: string | undefined }[];
  caveat?: string;
}

export interface Trial {
  model: string;
  caseId: string;
  run: number;
  ok: boolean;
  latencyMs: number;
  /** HTTP requests this trial used (fallback and 429 retries included). */
  requests: number;
  startedWith: ResponseMode;
  responseMode?: ResponseMode;
  fellBack: boolean;
  /** True when json_schema was skipped because an earlier trial of this model had to fall back. */
  memoizedFallback: boolean;
  fallbackFrom?: { providerErrorType?: string; providerErrorCode?: string };
  finishReason?: string;
  usage?: GroqUsage;
  /** null = unknown (the request failed before a completion was produced). */
  jsonParsed: boolean | null;
  schemaValid: boolean | null;
  answer?: AnswerRecord;
  errorCode?: string;
  errorStage?: InvalidResponseStage;
  status?: number;
  providerErrorType?: string;
  providerErrorCode?: string;
  retryAfterMs?: number;
  rateLimitWaits: number;
  flags: string[];
}

export interface ModelSummary {
  model: string;
  trials: number;
  ok: number;
  availabilityPct: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  meanCompletionTokens: number | null;
  meanReasoningTokens: number | null;
  jsonValidityPct: number | null;
  schemaValidityPct: number | null;
  fallbacks: number;
  jsonSchemaAccepted: boolean | null;
  reasoningEffortSent: 'low' | null;
  truncations: number;
  injectionFollowed: number;
  errors: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
}

const REASONING_ID_PATTERN =
  /gpt-oss|qwen3|qwq|deepseek-r1|r1-distill|reason|muse-spark|(^|[/-])o[134]([-/]|$)/i;

export interface NonReasoningPick {
  id: string;
  why: string;
  considered: { id: string; score: number }[];
}

/** Choose ONE fast non-reasoning text model from the account's list, by id heuristics. */
export function pickNonReasoningModel(
  models: Pick<GroqModel, 'id' | 'active'>[],
): NonReasoningPick | null {
  const pool = models.filter(
    (m) => m.active !== false && isTextChatModel(m.id) && !REASONING_ID_PATTERN.test(m.id),
  );
  const scored = pool
    .map((m) => {
      let score = 0;
      const reasons: string[] = [];
      if (/instant/i.test(m.id)) {
        score += 100;
        reasons.push('"instant" in id');
      }
      const size = /(?:^|[-_/])(\d+(?:\.\d+)?)b(?=$|[-_])/i.exec(m.id)?.[1];
      if (size !== undefined) {
        const b = Number(size);
        if (b >= 7 && b <= 9) {
          score += 40;
          reasons.push(`${b}B parameters`);
        } else if (b < 7) {
          score += 25;
          reasons.push(`small (${b}B)`);
        } else if (b <= 40) {
          score += 5;
        }
      }
      if (/flash|turbo|mini|small|lite/i.test(m.id)) {
        score += 20;
        reasons.push('speed-oriented name');
      }
      return { id: m.id, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const best = scored[0];
  if (!best) return null;
  const considered = scored.slice(0, 5).map(({ id, score }) => ({ id, score }));
  const why =
    best.score > 0
      ? `highest id-heuristic score ${best.score} (${best.reasons.join(', ')}); not a reasoning model`
      : 'no instant/small model found; first non-reasoning text model alphabetically (weak choice)';
  return { id: best.id, why, considered };
}

/** Heuristic only: did the answer obey an injected "reply only with X" instruction? */
export function followedInjection(answer: AnswerRecord, markers: string[]): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const fields = [answer.title, answer.summary].map(norm);
  return markers.some((marker) => {
    const m = norm(marker);
    return m !== '' && fields.some((f) => f === m || f.startsWith(`${m} `));
  });
}

function classify(trial: Trial): void {
  if (trial.ok) {
    trial.jsonParsed = true;
    trial.schemaValid = true;
  } else if (trial.errorCode === 'INVALID_RESPONSE') {
    const stage = trial.errorStage;
    trial.jsonParsed =
      stage === 'schema'
        ? trial.status === 400
          ? null
          : true
        : stage === undefined
          ? null
          : false;
    trial.schemaValid = false;
  }
}

export function summarize(model: string, trials: Trial[]): ModelSummary {
  const mine = trials.filter((t) => t.model === model);
  const ok = mine.filter((t) => t.ok);
  const answered = mine.filter((t) => t.schemaValid !== null);
  const parsedKnown = mine.filter((t) => t.jsonParsed !== null);
  const errors: Record<string, number> = {};
  for (const t of mine) if (t.errorCode) errors[t.errorCode] = (errors[t.errorCode] ?? 0) + 1;
  const completion = mine.flatMap((t) =>
    t.usage?.completionTokens !== undefined ? [t.usage.completionTokens] : [],
  );
  const reasoning = mine.flatMap((t) =>
    t.usage?.reasoningTokens !== undefined ? [t.usage.reasoningTokens] : [],
  );
  const latencies = ok.map((t) => t.latencyMs);
  const fellBack = mine.filter((t) => t.fellBack || t.memoizedFallback).length;
  const triedSchema = mine.filter((t) => t.startedWith === 'json_schema' || t.fellBack);
  const schemaWorked = triedSchema.some((t) => t.ok && t.responseMode === 'json_schema');
  return {
    model,
    trials: mine.length,
    ok: ok.length,
    availabilityPct: pct(ok.length, mine.length),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    meanCompletionTokens: mean(completion),
    meanReasoningTokens: mean(reasoning),
    jsonValidityPct: pct(parsedKnown.filter((t) => t.jsonParsed).length, parsedKnown.length),
    schemaValidityPct: pct(ok.length, answered.length),
    fallbacks: fellBack,
    jsonSchemaAccepted: triedSchema.length === 0 ? null : schemaWorked,
    reasoningEffortSent: getModelCapabilities(model).reasoningEffort,
    truncations: mine.filter((t) => t.errorStage === 'truncated' || t.finishReason === 'length')
      .length,
    injectionFollowed: mine.filter((t) => t.flags.includes('followed-injection')).length,
    errors,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): Options {
  const options: Options = { runs: 3, mock: false, maxRequests: 63, maxWaitSeconds: 60 };
  const intArg = (flag: string, raw: string | undefined, min: number, max: number): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${flag} expects an integer between ${min} and ${max}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--mock':
        options.mock = true;
        break;
      case '--runs':
        options.runs = intArg(arg, argv[(i += 1)], 1, 10);
        break;
      case '--max-requests':
        options.maxRequests = intArg(arg, argv[(i += 1)], 1, 500);
        break;
      case '--max-wait-seconds':
        options.maxWaitSeconds = intArg(arg, argv[(i += 1)], 0, 600);
        break;
      case '--max-completion-tokens':
        options.maxCompletionTokens = intArg(arg, argv[(i += 1)], 64, 32_768);
        break;
      default:
        throw new Error('Unknown argument (see the flag list at the top of this file)');
    }
  }
  return options;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const silentLogger = { debug: () => undefined, warn: () => undefined, error: () => undefined };

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface RunState {
  requests: number;
  stopReason?: string;
  interrupted: boolean;
  consecutiveTransportErrors: number;
}

async function runTrial(args: {
  provider: GroqProvider;
  apiKey: string;
  model: string;
  testCase: CoreCase;
  run: number;
  request: ExplainRequest;
  memoizedFallback: boolean;
  options: Options;
  state: RunState;
}): Promise<Trial | null> {
  const { provider, apiKey, model, testCase, run, request, options, state } = args;
  const startedWith: ResponseMode = args.memoizedFallback ? 'json_object' : 'json_schema';
  let rateLimitWaits = 0;
  for (;;) {
    if (state.interrupted) return null;
    if (state.requests >= options.maxRequests) {
      state.stopReason ??= `request cap of ${options.maxRequests} reached`;
      return null;
    }
    const requestsBefore = state.requests;
    const started = performance.now();
    const base: Trial = {
      model,
      caseId: testCase.id,
      run,
      ok: false,
      latencyMs: 0,
      requests: 0,
      startedWith,
      fellBack: false,
      memoizedFallback: args.memoizedFallback,
      jsonParsed: null,
      schemaValid: null,
      rateLimitWaits,
      flags: [],
    };
    try {
      const details: ExplainDetails = await provider.explainDetailed(request, {
        apiKey,
        model,
        responseMode: startedWith,
        ...(options.maxCompletionTokens !== undefined
          ? { maxCompletionTokens: options.maxCompletionTokens }
          : {}),
      });
      const { result } = details;
      const answer: AnswerRecord = {
        title: result.title,
        summary: result.summary,
        ...(result.contextualMeaning !== undefined
          ? { contextualMeaning: result.contextualMeaning }
          : {}),
        ...(result.definition !== undefined ? { definition: result.definition } : {}),
        ...(result.examples ? { examples: result.examples } : {}),
        ...(result.caveat !== undefined ? { caveat: result.caveat } : {}),
      };
      const trial: Trial = {
        ...base,
        ok: true,
        latencyMs: Math.round(performance.now() - started),
        requests: state.requests - requestsBefore,
        responseMode: details.responseMode,
        fellBack: details.fellBack,
        ...(details.fallbackFrom ? { fallbackFrom: details.fallbackFrom } : {}),
        ...(details.finishReason !== undefined ? { finishReason: details.finishReason } : {}),
        usage: details.usage,
        answer,
      };
      if (testCase.injectionMarkers && followedInjection(answer, testCase.injectionMarkers)) {
        trial.flags.push('followed-injection');
      }
      classify(trial);
      state.consecutiveTransportErrors = 0;
      return trial;
    } catch (error) {
      const code = error instanceof GroqError ? error.code : 'NETWORK_ERROR';
      if (code === 'RATE_LIMITED') {
        const waitMs =
          error instanceof GroqError ? (error.retryAfterMs ?? 5_000 * (rateLimitWaits + 1)) : 5_000;
        if (waitMs > options.maxWaitSeconds * 1000 || rateLimitWaits >= 2) {
          state.stopReason = `persistent rate limiting (HTTP 429, wait ${Math.round(waitMs / 1000)}s requested)`;
        } else {
          rateLimitWaits += 1;
          console.error(`  429: waiting ${Math.round(waitMs / 1000)}s (Retry-After honoured)`);
          await sleep(waitMs);
          continue;
        }
      }
      const trial: Trial = {
        ...base,
        latencyMs: Math.round(performance.now() - started),
        requests: state.requests - requestsBefore,
        errorCode: code,
      };
      if (error instanceof GroqError) {
        if (error.stage) trial.errorStage = error.stage;
        if (error.status !== undefined) trial.status = error.status;
        if (error.providerErrorType) trial.providerErrorType = error.providerErrorType;
        if (error.providerErrorCode) trial.providerErrorCode = error.providerErrorCode;
        if (error.retryAfterMs !== undefined) trial.retryAfterMs = error.retryAfterMs;
        if (error.usage) trial.usage = error.usage;
      }
      classify(trial);
      if (code === 'INVALID_API_KEY') state.stopReason = 'the API key was rejected (401/403)';
      if (code === 'NETWORK_ERROR' || code === 'TIMEOUT') {
        state.consecutiveTransportErrors += 1;
        if (state.consecutiveTransportErrors >= 3)
          state.stopReason = 'repeated network errors or timeouts';
      } else {
        state.consecutiveTransportErrors = 0;
      }
      return trial;
    }
  }
}

function fmt(value: number | null, digits = 0, suffix = ''): string {
  return value === null ? 'n/a' : `${value.toFixed(digits)}${suffix}`;
}

function cell(text: string | undefined): string {
  return (text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function renderMarkdown(report: {
  generatedAt: string;
  options: Options;
  stopReason: string | undefined;
  totalRequests: number;
  nonReasoning: NonReasoningPick | null;
  absent: string[];
  models: string[];
  summaries: ModelSummary[];
  trials: Trial[];
  cases: CoreCase[];
}): string {
  const lines: string[] = [];
  const out = (line = '') => lines.push(line);
  out(
    `# Spike A model comparison${report.options.mock ? ' (MOCK DATA, not provider output)' : ''}`,
  );
  out();
  out(`- Generated: ${report.generatedAt}`);
  out(
    `- Runs per model and case: ${report.options.runs}; HTTP requests used: ${report.totalRequests} (cap ${report.options.maxRequests})`,
  );
  out(`- Models: ${report.models.join(', ')}`);
  if (report.absent.length > 0)
    out(`- Candidates not available to the account: ${report.absent.join(', ')}`);
  if (report.nonReasoning) {
    out(
      `- Non-reasoning model chosen: \`${report.nonReasoning.id}\` because ${report.nonReasoning.why}`,
    );
  } else {
    out('- No non-reasoning text model was found in the account list.');
  }
  if (report.stopReason)
    out(`- **Stopped early:** ${report.stopReason}. Figures below cover only completed trials.`);
  out();
  out('## Per-model numbers');
  out();
  out(
    'Latency percentiles use successful trials only (nearest rank; small n, so p95 is close to the maximum). JSON validity counts trials that produced a completion; schema validity is successes / trials that reached a completion.',
  );
  out();
  out(
    '| Model | Trials | OK | p50 ms | p95 ms | Mean completion tok | Mean reasoning tok | JSON valid | Schema valid | Used json_object fallback | Truncated | Obeyed injection |',
  );
  out('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of report.summaries) {
    out(
      `| \`${s.model}\` | ${s.trials} | ${s.ok} | ${fmt(s.p50LatencyMs)} | ${fmt(s.p95LatencyMs)} | ${fmt(s.meanCompletionTokens, 0)} | ${fmt(s.meanReasoningTokens, 0)} | ${fmt(s.jsonValidityPct, 1, '%')} | ${fmt(s.schemaValidityPct, 1, '%')} | ${s.fallbacks} | ${s.truncations} | ${s.injectionFollowed} |`,
    );
  }
  out();
  out('## Observed capabilities');
  out();
  out('| Model | json_schema accepted | reasoning_effort sent | Errors |');
  out('| --- | --- | --- | --- |');
  for (const s of report.summaries) {
    const accepted =
      s.jsonSchemaAccepted === null
        ? 'not tried'
        : s.jsonSchemaAccepted
          ? 'yes'
          : 'no (fell back to json_object)';
    const errors =
      Object.entries(s.errors)
        .map(([k, v]) => `${k} x${v}`)
        .join(', ') || 'none';
    out(`| \`${s.model}\` | ${accepted} | ${s.reasoningEffortSent ?? 'no'} | ${errors} |`);
  }
  const fallbackTrials = report.trials.filter((t) => t.fellBack && t.fallbackFrom);
  if (fallbackTrials.length > 0) {
    out();
    out('First rejected json_schema attempt per model (provider error identifiers only):');
    out();
    for (const model of new Set(fallbackTrials.map((t) => t.model))) {
      const first = fallbackTrials.find((t) => t.model === model);
      out(
        `- \`${model}\`: type=${first?.fallbackFrom?.providerErrorType ?? 'n/a'}, code=${first?.fallbackFrom?.providerErrorCode ?? 'n/a'}`,
      );
    }
  }
  out();
  out('## Decision criteria (D-09)');
  out();
  out(
    'A model qualifies when schema validity >= 95% AND bank (both senses), the idiom and the injection case read as acceptable below. Among qualifying models, the lowest p95 wins for quick; pick the best-quality qualifying one for deep.',
  );
  out();
  out('| Model | Schema valid >= 95% | p95 ms | Quality (human review) |');
  out('| --- | --- | ---: | --- |');
  for (const s of report.summaries) {
    const pass = s.schemaValidityPct === null ? 'n/a' : s.schemaValidityPct >= 95 ? 'yes' : 'NO';
    out(`| \`${s.model}\` | ${pass} | ${fmt(s.p95LatencyMs)} | _fill in_ |`);
  }
  out();
  out('## Answers for human quality review');
  out();
  out('First successful run per model and case (all runs are in the JSON file).');
  for (const testCase of report.cases.filter((c) => c.review)) {
    out();
    out(`### ${testCase.label} (\`${testCase.id}\`)`);
    out();
    out(`Check: ${testCase.humanCheck}`);
    for (const model of report.models) {
      const trial = report.trials.find(
        (t) => t.model === model && t.caseId === testCase.id && t.ok,
      );
      out();
      out(
        `**\`${model}\`**${trial?.flags.includes('followed-injection') ? ' **(obeyed the injection)**' : ''}`,
      );
      out();
      if (!trial?.answer) {
        const failed = report.trials.find((t) => t.model === model && t.caseId === testCase.id);
        out(`_No successful answer${failed?.errorCode ? ` (${failed.errorCode})` : ''}._`);
        continue;
      }
      const a = trial.answer;
      out(`- Title: ${cell(a.title)}`);
      out(`- Summary: ${cell(a.summary)}`);
      out(`- In context: ${cell(a.contextualMeaning)}`);
      out(`- Definition: ${cell(a.definition)}`);
      for (const [i, example] of (a.examples ?? []).entries())
        out(`- Example ${i + 1}: ${cell(example.sentence)}`);
      if (a.caveat) out(`- Caveat: ${cell(a.caveat)}`);
    }
  }
  out();
  return lines.join('\n');
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid arguments');
    process.exitCode = 2;
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');

  const cases = JSON.parse(
    await readFile(path.join(here, 'fixtures', 'core-cases.json'), 'utf8'),
  ) as CoreCase[];
  const requests = new Map<string, ExplainRequest>();
  cases.forEach((c, index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    requests.set(
      c.id,
      explainRequestSchema.parse({
        requestId: id,
        snapshot: { selectionId: id, source: 'webpage', ...c.snapshot },
        mode: 'core',
        detailLevel: 'standard',
        ...(c.targetLanguage ? { targetLanguage: c.targetLanguage } : {}),
      }),
    );
  });

  // Key handling: read once, validate shape, never print or persist.
  let apiKey: string;
  if (options.mock) {
    apiKey = 'gsk_TEST_mock_key_not_real';
  } else {
    const fromEnv = process.env['GROQ_API_KEY'];
    if (!fromEnv || !fromEnv.startsWith('gsk_')) {
      console.error(
        'GROQ_API_KEY is missing or does not start with "gsk_". Set it in the environment (it is never printed). Use --mock for an offline dry run.',
      );
      process.exitCode = 2;
      return;
    }
    apiKey = fromEnv;
  }

  const state: RunState = { requests: 0, interrupted: false, consecutiveTransportErrors: 0 };
  const baseFetch = options.mock
    ? createMockFetch(cases.map((c) => ({ id: c.id, text: String(c.snapshot['text']) })))
    : (url: string, init: RequestInit) => globalThis.fetch(url, init);
  const provider = new GroqProvider({
    logger: silentLogger,
    fetch: (url, init) => {
      state.requests += 1;
      return baseFetch(url, init);
    },
  });
  process.on('SIGINT', () => {
    state.interrupted = true;
    console.error('\nInterrupted: finishing the current request, then writing partial results.');
  });

  console.error(
    `Mode: ${options.mock ? 'MOCK (offline)' : 'live Groq API'}; runs=${options.runs}; request cap=${options.maxRequests}`,
  );
  const models = await provider.listModels(apiKey);
  console.error(`Account lists ${models.length} models.`);

  const wanted = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
  const listedIds = new Set(models.map((m) => m.id));
  const chosen = wanted.filter((id) => listedIds.has(id));
  const absent = wanted.filter((id) => !listedIds.has(id));
  for (const id of absent) console.error(`Skipping ${id}: not in this account's model list.`);
  const nonReasoning = pickNonReasoningModel(models);
  if (nonReasoning) {
    console.error(
      `Non-reasoning model: ${nonReasoning.id} (${nonReasoning.why}). Considered: ${nonReasoning.considered.map((c) => `${c.id}=${c.score}`).join(', ')}`,
    );
    chosen.push(nonReasoning.id);
  } else {
    console.error(
      'No non-reasoning text model found in the list; comparison will cover reasoning models only.',
    );
  }
  if (chosen.length === 0) {
    console.error('No candidate models available; nothing to compare.');
    process.exitCode = 1;
    return;
  }

  const planned = chosen.length * cases.length * options.runs;
  console.error(
    `Plan: ${chosen.length} models x ${cases.length} cases x ${options.runs} runs = ${planned} trials (request cap ${options.maxRequests}).`,
  );

  const trials: Trial[] = [];
  const memoizedFallback = new Set<string>();
  outer: for (let run = 1; run <= options.runs; run += 1) {
    for (const testCase of cases) {
      const request = requests.get(testCase.id);
      if (!request) continue;
      for (const model of chosen) {
        const trial = await runTrial({
          provider,
          apiKey,
          model,
          testCase,
          run,
          request,
          memoizedFallback: memoizedFallback.has(model),
          options,
          state,
        });
        if (!trial) break outer;
        trials.push(trial);
        if (trial.fellBack) memoizedFallback.add(model);
        console.error(
          `[${trials.length}/${planned}] ${model} ${testCase.id} #${run}: ${trial.ok ? 'ok' : (trial.errorCode ?? 'error')} ${trial.latencyMs}ms${trial.fellBack ? ' (fell back to json_object)' : ''}${trial.flags.length ? ` [${trial.flags.join(',')}]` : ''}`,
        );
        if (state.stopReason) break outer;
      }
    }
  }
  if (state.interrupted) state.stopReason ??= 'interrupted by user';
  if (state.stopReason) console.error(`Stopping: ${state.stopReason}.`);

  const generatedAt = new Date();
  const summaries = chosen.map((model) => summarize(model, trials));
  const report = {
    generatedAt: generatedAt.toISOString(),
    mock: options.mock,
    options,
    stopReason: state.stopReason,
    totalRequests: state.requests,
    nonReasoning,
    absent,
    models: chosen,
    summaries,
    trials,
    cases,
  };

  const outDir = path.join(repoRoot, 'docs', 'decisions', 'spike-a-results');
  await mkdir(outDir, { recursive: true });
  const base = `${stamp(generatedAt)}${options.mock ? '-mock' : ''}`;
  const jsonPath = path.join(outDir, `${base}-results.json`);
  const mdPath = path.join(outDir, `${base}-summary.md`);
  await writeFile(
    jsonPath,
    `${JSON.stringify({ ...report, cases: undefined, caseIds: cases.map((c) => c.id) }, null, 2)}\n`,
  );
  await writeFile(mdPath, renderMarkdown(report));
  console.error(`Wrote ${path.relative(repoRoot, jsonPath)}`);
  console.error(`Wrote ${path.relative(repoRoot, mdPath)}`);
  console.error(
    'Review the "Answers for human quality review" section, then fill in docs/decisions/spike-a-groq.md.',
  );
  for (const s of summaries) {
    console.error(
      `  ${s.model}: ok ${s.ok}/${s.trials}, p50 ${fmt(s.p50LatencyMs)}ms, p95 ${fmt(s.p95LatencyMs)}ms, schema valid ${fmt(s.schemaValidityPct, 1, '%')}`,
    );
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    // Print the error class/code only: never a message, which could in principle echo input.
    const label =
      error instanceof GroqError
        ? `${error.name} ${error.code}`
        : error instanceof Error
          ? error.name
          : 'unknown error';
    console.error(`groq-compare failed: ${label}`);
    process.exitCode = 1;
  });
}
