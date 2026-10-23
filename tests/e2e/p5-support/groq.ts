import type { BrowserContext } from '@playwright/test';

// Fake keys MUST start with gsk_TEST (gitleaks allowlist).
export type { Reply } from '../p3-support/background';

export interface GroqCall {
  url: string;
  method: string;
  authorization: string | undefined;
  /** Parsed JSON body of a chat completion, when there was one. */
  body: ChatBody | undefined;
}

export interface ChatBody {
  model: string;
  messages: { role: string; content: string }[];
  response_format: {
    type: string;
    json_schema?: { name: string; strict: boolean; schema: unknown };
  };
  max_completion_tokens: number;
  reasoning_effort?: string;
}

export interface FakeGroq {
  calls: GroqCall[];
  /** Calls to /chat/completions only. */
  chats(): GroqCall[];
  /** Models whose json_schema requests are answered with Groq's "unsupported response_format" 400. */
  rejectJsonSchema: Set<string>;
  /** Answer every chat completion with this status (and an error body); `undefined` = normal. */
  chatStatus: { current: number | undefined; retryAfter?: string };
  reset(): void;
}

/** A valid model answer per mode, in the shape the strict schema asks for. */
const OUTPUTS: Record<string, unknown> = {
  core: {
    title: 'bank',
    summary: 'The land beside a river.',
    contextualMeaning: 'Here it is the riverside.',
    definition: 'The raised ground along a river.',
    examples: [
      { sentence: 'We sat on the bank.', note: null },
      { sentence: 'The bank flooded.', note: null },
    ],
    caveat: null,
  },
  etymology: {
    overview: 'From Old Norse banki, a ridge. Confidence is moderate.',
    confidence: 'known',
    caveat: null,
  },
  related_words: { synonyms: ['shore', 'embankment'], antonyms: [] },
  simplify: { simplifiedText: 'The ground next to the river.', caveat: null },
  grammar: { grammar: 'Noun, singular.', caveat: null },
  translate: { language: 'French', text: 'la rive', literal: null, caveat: null },
};

const MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'whisper-large-v3'];

/**
 * Answer the service worker's calls to Groq without touching the network. The chat answer is the
 * valid output of whichever mode the prompt asks for (read from "(mode: X)" in the user message).
 */
export async function fakeGroq(context: BrowserContext): Promise<FakeGroq> {
  const state: FakeGroq = {
    calls: [],
    chats: () => state.calls.filter((c) => c.url.endsWith('/chat/completions')),
    rejectJsonSchema: new Set(),
    chatStatus: { current: undefined },
    reset: () => {
      state.calls.length = 0;
    },
  };
  await context.route('https://api.groq.com/**', async (route) => {
    const request = route.request();
    const isChat = request.url().endsWith('/chat/completions');
    const body = isChat ? (request.postDataJSON() as ChatBody) : undefined;
    state.calls.push({
      url: request.url(),
      method: request.method(),
      authorization: await request.headerValue('authorization').then((v) => v ?? undefined),
      body,
    });

    if (!isChat) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          object: 'list',
          data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'x', active: true })),
        }),
      });
    }
    const { current, retryAfter } = state.chatStatus;
    if (current !== undefined) {
      return route.fulfill({
        status: current,
        contentType: 'application/json',
        headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
        body: JSON.stringify({ error: { message: 'fake failure', type: 'fake_error' } }),
      });
    }
    if (body?.response_format.type === 'json_schema' && state.rejectJsonSchema.has(body.model)) {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            message: '`response_format` of type `json_schema` is not supported with this model',
            type: 'invalid_request_error',
          },
        }),
      });
    }
    const mode = /\(mode: (\w+)\)/.exec(body?.messages[1]?.content ?? '')?.[1] ?? 'core';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [
          {
            message: { role: 'assistant', content: JSON.stringify(OUTPUTS[mode]), reasoning: 'x' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
      }),
    });
  });
  return state;
}

/** A well-formed AI_EXPLAIN message. */
export function explainMessage(
  mode: string,
  over: { text?: string; contextBefore?: string; targetLanguage?: string; acknowledge?: true } = {},
): Record<string, unknown> {
  const id = crypto.randomUUID();
  return {
    v: 1,
    type: 'AI_EXPLAIN',
    payload: {
      requestId: id,
      snapshot: {
        selectionId: crypto.randomUUID(),
        source: 'webpage',
        kind: 'word',
        text: over.text ?? 'bank',
        ...(over.contextBefore === undefined ? {} : { contextBefore: over.contextBefore }),
      },
      mode,
      detailLevel: 'standard',
      ...(over.targetLanguage === undefined ? {} : { targetLanguage: over.targetLanguage }),
    },
    ...(over.acknowledge === true ? { acknowledgeDisclosure: true } : {}),
  };
}
