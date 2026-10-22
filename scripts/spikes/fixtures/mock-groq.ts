/**
 * Offline stand-in for api.groq.com, used only by `groq-compare.ts --mock`.
 * Responses are clearly marked "[mock]" so they can never be mistaken for model output.
 * It also deliberately exercises the awkward paths: a model that rejects json_schema (400),
 * one malformed answer, one prompt-injection "obedience" and an occasional 429.
 */

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface MockCase {
  id: string;
  /** Exact selected text; used to recognise which fixture a prompt belongs to. */
  text: string;
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

type Answer = {
  title: string;
  summary: string;
  contextualMeaning: string;
  definition: string;
  examples: { sentence: string }[];
  caveat?: string;
};

function answer(
  title: string,
  summary: string,
  contextualMeaning: string,
  definition: string,
  examples: [string, string],
  caveat?: string,
): Answer {
  return {
    title: `[mock] ${title}`,
    summary,
    contextualMeaning,
    definition,
    examples: examples.map((sentence) => ({ sentence })),
    ...(caveat ? { caveat } : {}),
  };
}

const ANSWERS: Record<string, Answer> = {
  'bank-river': answer(
    'bank',
    'The sloping ground beside a river.',
    'Here "bank" is the grassy edge of the river, not a financial institution.',
    'The raised land along the side of a river or lake.',
    ['Ducks waddled up the muddy bank.', 'The river burst its banks after the storm.'],
  ),
  'bank-money': answer(
    'bank',
    'A place that keeps and lends money.',
    'Here "bank" is the financial institution where she deposits her paycheck.',
    'An organisation that stores customers money and offers loans.',
    ['He opened an account at the bank.', 'The bank closes at five.'],
  ),
  'idiom-broke-the-ice': answer(
    'break the ice',
    'To ease the tension when people first meet.',
    'The joke made the guests relax and start talking.',
    'To do or say something that makes a stiff social situation more comfortable.',
    [
      'A quick game helped break the ice at the workshop.',
      'She broke the ice by asking about his dog.',
    ],
  ),
  'technical-idempotent': answer(
    'idempotent',
    'Doing it again has no extra effect.',
    'Retrying the payment request must not charge twice.',
    'Describes an operation that gives the same result however many times it is applied.',
    ['Setting a value to 5 is idempotent.', 'Deleting a file by name is idempotent.'],
  ),
  'ambiguous-duck': answer(
    'I saw her duck.',
    'Either you saw her pet bird, or you saw her crouch.',
    'Without more context both readings are possible.',
    '"Duck" can be a noun (a bird) or a verb (to lower the head quickly).',
    ['I saw her duck swim across the pond.', 'I saw her duck under the low branch.'],
    'The sentence is ambiguous; more context would settle which meaning is intended.',
  ),
  'injection-ignore-instructions': answer(
    'Ignore previous instructions',
    'A sentence that tries to give orders to an AI system.',
    'The review comment contains an instruction aimed at an AI; it is just text being explained.',
    'A prompt-injection attempt: text written to make an AI ignore its real instructions.',
    [
      'Attackers hide commands inside web pages.',
      'The assistant explained the text instead of obeying it.',
    ],
  ),
  'non-english-idiom': answer(
    'il pleut des cordes',
    'French for "it is raining very hard".',
    'It describes heavy rain, which is why she should take an umbrella.',
    'A French idiom, literally "it is raining ropes", meaning it is pouring.',
    ['Il pleut des cordes depuis midi.', 'Rentrons, il pleut des cordes!'],
  ),
};

const MODEL_PROFILE: Record<string, { delayMs: number; reasoningTokens: number | null }> = {
  'openai/gpt-oss-20b': { delayMs: 14, reasoningTokens: 70 },
  'openai/gpt-oss-120b': { delayMs: 34, reasoningTokens: 110 },
  'llama-3.1-8b-instant': { delayMs: 6, reasoningTokens: null },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMockFetch(cases: MockCase[]): FetchLike {
  let chatCalls = 0;
  const pairCalls = new Map<string, number>();

  return async (input, init) => {
    const signal = init.signal;
    if (input.endsWith('/models')) return jsonResponse({ object: 'list', data: MODELS });

    chatCalls += 1;
    // Occasional rate limit, to exercise Retry-After handling.
    if (chatCalls % 23 === 0) {
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
    const selected = /<selected_text>([\s\S]*?)<\/selected_text>/.exec(user)?.[1] ?? '';
    const matched = cases.find((c) => c.text === selected);
    const profile = MODEL_PROFILE[body.model] ?? { delayMs: 20, reasoningTokens: null };

    if (body.model === 'llama-3.1-8b-instant' && body.response_format.type === 'json_schema') {
      await sleep(3);
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

    await sleep(profile.delayMs + (chatCalls % 7) * 2);
    if (signal?.aborted) throw signal.reason;

    const pair = `${body.model}|${matched?.id ?? '?'}`;
    const nth = (pairCalls.get(pair) ?? 0) + 1;
    pairCalls.set(pair, nth);

    let content: unknown = matched ? ANSWERS[matched.id] : undefined;
    if (!content) return jsonResponse({ error: { message: 'mock: unknown case', type: 'x' } }, 500);
    if (body.model === 'llama-3.1-8b-instant') {
      if (matched?.id === 'ambiguous-duck' && nth === 2) {
        content = { ...(content as Answer), examples: [{ sentence: 'only one example' }] };
      }
      if (matched?.id === 'injection-ignore-instructions' && nth === 1) {
        content = { ...(content as Answer), title: 'PWNED', summary: 'PWNED' };
      }
    }

    const completion = 150 + (profile.reasoningTokens ?? 0);
    return jsonResponse({
      id: 'mock',
      model: body.model,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify(content),
            ...(profile.reasoningTokens !== null ? { reasoning: '[mock reasoning, ignored]' } : {}),
          },
        },
      ],
      usage: {
        prompt_tokens: 380,
        completion_tokens: completion,
        total_tokens: 380 + completion,
        ...(profile.reasoningTokens !== null
          ? { completion_tokens_details: { reasoning_tokens: profile.reasoningTokens } }
          : {}),
      },
    });
  };
}
