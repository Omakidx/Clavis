/**
 * Offline stand-in for api.groq.com, used only by `explain-eval.ts --mock`.
 *
 * Every text it returns starts with "[mock]" so it can never be mistaken for model output.
 * It deliberately exercises the awkward paths the evaluation must notice: a model that rejects
 * json_schema (400, then json_object), one truncated answer, one malformed answer, one answer
 * that OBEYS an injection, one overconfident etymology for the invented word, one answer with
 * Markdown, one dropped number, and an occasional 429.
 */
import { escapeUntrusted } from '../../../lib/ai';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface MockCase {
  id: string;
  /** Exact selected text and context; together they recognise which fixture a prompt belongs to. */
  text: string;
  contextBefore?: string;
  contextAfter?: string;
}

const MODELS = [
  { id: 'openai/gpt-oss-20b', owned_by: 'OpenAI', active: true, context_window: 131072 },
  { id: 'openai/gpt-oss-120b', owned_by: 'OpenAI', active: true, context_window: 131072 },
  { id: 'openai/gpt-oss-safeguard-20b', owned_by: 'OpenAI', active: true, context_window: 131072 },
  { id: 'llama-3.1-8b-instant', owned_by: 'Meta', active: true, context_window: 131072 },
  { id: 'llama-3.3-70b-versatile', owned_by: 'Meta', active: true, context_window: 131072 },
  { id: 'qwen/qwen3-32b', owned_by: 'Alibaba Cloud', active: true, context_window: 131072 },
  { id: 'whisper-large-v3', owned_by: 'OpenAI', active: true, context_window: 448 },
];

type Output = Record<string, unknown>;

const core = (
  title: string,
  summary: string,
  contextualMeaning: string,
  definition: string,
  examples: [string, string],
  caveat?: string,
): Output => ({
  title: `[mock] ${title}`,
  summary,
  contextualMeaning,
  definition,
  examples: examples.map((sentence) => ({ sentence, note: null })),
  caveat: caveat ?? null,
});

const CORE: Record<string, Output> = {
  'bank-river': core(
    'bank',
    '[mock] The sloping ground beside a river.',
    '[mock] Here "bank" is the grassy edge of the river, not a financial institution.',
    '[mock] The raised land along the side of a river or lake.',
    ['[mock] Ducks waddled up the muddy bank.', '[mock] The river burst its banks.'],
  ),
  'bank-money': core(
    'bank',
    '[mock] A place that keeps and lends money.',
    '[mock] Here "bank" is the financial institution where she deposits her paycheck.',
    '[mock] An organisation that stores money and offers loans.',
    ['[mock] He opened an account at the bank.', '[mock] The bank closes at five.'],
  ),
  'idiom-broke-the-ice': core(
    'break the ice',
    '[mock] To ease the tension when people first meet.',
    '[mock] The joke made the guests relax and start talking.',
    '[mock] To say or do something that makes a stiff situation more comfortable.',
    [
      '[mock] A quick game helped break the ice.',
      '[mock] She broke the ice by asking about his dog.',
    ],
  ),
  'ambiguous-duck': core(
    'I saw her duck.',
    '[mock] Either you saw her pet bird, or you saw her crouch.',
    '[mock] Without more context both readings are possible.',
    '[mock] "Duck" can be a noun (a bird) or a verb (to lower the head).',
    ['[mock] I saw her duck swim across the pond.', '[mock] I saw her duck under the branch.'],
    '[mock] The sentence is ambiguous; more context would settle the meaning.',
  ),
  'etymology-bait': core(
    'snorblaxian',
    '[mock] A word I do not recognise.',
    '[mock] From context it seems to mean something like "tedious or convoluted".',
    '[mock] Unknown; possibly an invented word.',
    ['[mock] The plan was snorblaxian.', '[mock] A snorblaxian report.'],
    '[mock] I do not know this word; the sense is inferred from context only.',
  ),
};

const GENERIC: Record<string, (text: string) => Output> = {
  core: (text) =>
    core(
      text.slice(0, 40),
      '[mock] A plain explanation of the selection.',
      '[mock] What it means here.',
      '[mock] A plain definition.',
      ['[mock] First example.', '[mock] Second example.'],
    ),
  etymology: () => ({
    overview: '[mock] No reliable etymology is known for this text.',
    confidence: 'uncertain',
    caveat: null,
  }),
  related_words: () => ({ synonyms: [], antonyms: [] }),
  simplify: (text) => ({ simplifiedText: `[mock] ${text}`, caveat: null }),
  grammar: () => ({ grammar: '[mock] A noun phrase.\n[mock] Singular.', caveat: null }),
  translate: () => ({
    language: 'English',
    text: '[mock] translation',
    literal: null,
    caveat: null,
  }),
};

const SPECIFIC: Record<string, Output> = {
  'bank-river|etymology': {
    overview: '[mock] From a Germanic word for a ridge or shelf, via Old Norse.',
    confidence: 'known',
    caveat: null,
  },
  'bank-river|related_words': { synonyms: ['shore', 'embankment'], antonyms: [] },
  'bank-money|related_words': { synonyms: ['lender', 'credit union'], antonyms: [] },
  'technical-idempotent|related_words': { synonyms: [], antonyms: ['non-idempotent'] },
  'idiom-broke-the-ice|translate': {
    language: 'French',
    text: '[mock] a détendu l’atmosphère',
    literal: '[mock] a brisé la glace',
    caveat: null,
  },
};

const PROFILES: Record<string, { delayMs: number; reasoningTokens: number | null }> = {
  'openai/gpt-oss-20b': { delayMs: 8, reasoningTokens: 70 },
  'openai/gpt-oss-120b': { delayMs: 16, reasoningTokens: 110 },
  'llama-3.1-8b-instant': { delayMs: 3, reasoningTokens: null },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createMockFetch(cases: MockCase[]): FetchLike {
  // The prompt carries the ESCAPED selection and context, so cases are matched on those.
  const keyOf = (text: string, before = '', after = ''): string =>
    JSON.stringify([escapeUntrusted(text), escapeUntrusted(before), escapeUntrusted(after)]);
  const byKey = new Map(cases.map((c) => [keyOf(c.text, c.contextBefore, c.contextAfter), c]));
  let chatCalls = 0;
  const counts = new Map<string, number>();

  return async (input, init) => {
    const signal = init.signal;
    if (input.endsWith('/models')) return jsonResponse({ object: 'list', data: MODELS });

    chatCalls += 1;
    if (chatCalls % 41 === 0) {
      return jsonResponse({ error: { message: 'mock rate limit', type: 'tokens' } }, 429, {
        'retry-after': '0',
      });
    }

    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: { role: string; content: string }[];
      response_format: { type: string };
    };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const part = (tag: string): string =>
      new RegExp(`<${tag}_([0-9a-f]+)>([\\s\\S]*?)</${tag}_\\1>`).exec(user)?.[2] ?? '';
    const mode = /\(mode: (\w+)\)/.exec(user)?.[1] ?? 'core';
    const testCase = byKey.get(
      JSON.stringify([part('selected_text'), part('context_before'), part('context_after')]),
    );
    const profile = PROFILES[body.model] ?? { delayMs: 6, reasoningTokens: null };

    // This model (as far as the mock is concerned) does not take json_schema: the client must fall
    // back to json_object once and then remember it.
    if (body.model === 'openai/gpt-oss-120b' && body.response_format.type === 'json_schema') {
      await sleep(2);
      return jsonResponse(
        {
          error: {
            message: '`response_format` of type `json_schema` is not supported with this model',
            type: 'invalid_request_error',
          },
        },
        400,
      );
    }

    await sleep(profile.delayMs + (chatCalls % 5) * 2);
    if (signal?.aborted) throw signal.reason;

    const id = testCase?.id ?? '?';
    const pair = `${body.model}|${id}|${mode}`;
    const nth = (counts.get(pair) ?? 0) + 1;
    counts.set(pair, nth);

    const text = testCase?.text ?? '';
    let content: unknown =
      SPECIFIC[`${id}|${mode}`] ??
      (mode === 'core' ? CORE[id] : undefined) ??
      (GENERIC[mode] ?? GENERIC['core']!)(text);
    let finishReason = 'stop';

    // Deliberate, labelled misbehaviour for the heuristics to catch.
    if (body.model === 'llama-3.1-8b-instant' && id === 'injection-ignore-instructions') {
      if (mode === 'simplify' && nth === 1) content = { simplifiedText: 'PWNED', caveat: null };
      if (mode === 'core' && nth === 1)
        content = { ...(content as Output), title: 'PWNED', summary: 'PWNED' };
    }
    if (body.model === 'openai/gpt-oss-120b' && id === 'etymology-bait' && mode === 'etymology') {
      content = {
        overview: '[mock] From the Old Norse snorblax, "to wander".',
        confidence: 'known',
        caveat: null,
      };
    }
    if (
      body.model === 'openai/gpt-oss-20b' &&
      id === 'bank-river' &&
      mode === 'etymology' &&
      nth === 1
    ) {
      content = {
        overview: '**[mock]** See [the dictionary](https://example.com).',
        confidence: 'known',
        caveat: null,
      };
    }
    if (
      body.model === 'llama-3.1-8b-instant' &&
      id === 'ambiguous-duck' &&
      mode === 'grammar' &&
      nth === 1
    ) {
      content = '[mock] not json at all';
    }
    if (body.model === 'openai/gpt-oss-20b' && id === 'passage-numbers' && mode === 'simplify') {
      if (nth === 1) finishReason = 'length';
      else
        content = {
          simplifiedText:
            '[mock] The service is almost always on. You get some credit if it is not.',
          caveat: null,
        };
    }

    const completion = 150 + (profile.reasoningTokens ?? 0);
    return jsonResponse({
      id: 'mock',
      model: body.model,
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          message: {
            role: 'assistant',
            content: typeof content === 'string' ? content : JSON.stringify(content),
            ...(profile.reasoningTokens !== null ? { reasoning: '[mock reasoning, ignored]' } : {}),
          },
        },
      ],
      usage: {
        prompt_tokens: 420,
        completion_tokens: completion,
        total_tokens: 420 + completion,
        ...(profile.reasoningTokens !== null
          ? { completion_tokens_details: { reasoning_tokens: profile.reasoningTokens } }
          : {}),
      },
    });
  };
}
