import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { interpretReply } from '../../../components/explanation/backend';
import { toCardError } from '../../../components/explanation/session';
import { registerBackground } from '../../../lib/router/register';
import {
  lockDownStorage,
  resetStorageLockdownForTests,
} from '../../../lib/security/storage-lockdown';
import { STORAGE_KEYS } from '../../../lib/storage';
import {
  FAKE_KEY,
  ORIGIN,
  REQ_A,
  REQ_B,
  RUNTIME_ID,
  contentSender,
  pageSender,
  panelSender,
} from '../router/harness';
import { installCatalog } from '../ui-client/support';

// Phase 9, "Add chrome.runtime/storage message integration tests and secret-boundary checks"
// (FR-070, FR-072, FR-073, abuse cases 1, 5 and 7, architecture section 9 "Secret boundary").
//
// The REAL background composition (`registerBackground`: router, key service, stores, Groq
// provider, limiter, side-panel hand-off) runs over an in-memory `chrome.storage`, with only the
// network (`fetch`) and the browser's event plumbing replaced. Messages are delivered through the
// single registered `runtime.onMessage` listener, exactly as Chrome would, from realistic senders.
// A hostile "Groq" echoes the key, the selected text and markup in every body. After each scenario
// the test searches everything the background produced for the secrets: every reply, every log
// line, every runtime broadcast, every storage record other than the key's own, and every network
// request other than the Authorization header of a Groq call.

const SELECTED = 'SELECTEDTEXTCANARY';
const KEY_MIDDLE = FAKE_KEY.slice('gsk_TEST'.length, -4);

type Listener = (...args: unknown[]) => unknown;
const listeners = new Map<string, Listener[]>();
const eventFor = (name: string) => ({
  addListener: vi.fn((l: Listener) => {
    listeners.set(name, [...(listeners.get(name) ?? []), l]);
  }),
});

function installBrowser(): void {
  listeners.clear();
  Object.assign(browser, {
    permissions: {
      contains: vi.fn(() => Promise.resolve(false)),
      onAdded: eventFor('permAdded'),
      onRemoved: eventFor('permRemoved'),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(() => Promise.resolve([])),
      registerContentScripts: vi.fn(() => Promise.resolve()),
      updateContentScripts: vi.fn(() => Promise.resolve()),
      unregisterContentScripts: vi.fn(() => Promise.resolve()),
      executeScript: vi.fn(() => Promise.resolve([{ frameId: 0 }])),
    },
    tabs: {
      sendMessage: vi.fn(() => Promise.resolve({ ok: true, shown: true })),
      query: vi.fn(() => Promise.resolve([])),
      create: vi.fn(() => Promise.resolve({})),
      onRemoved: eventFor('tabRemoved'),
      onUpdated: eventFor('tabUpdated'),
    },
    sidePanel: { setOptions: vi.fn(() => Promise.resolve()), open: vi.fn(() => Promise.resolve()) },
    contextMenus: { create: vi.fn(), removeAll: vi.fn(), onClicked: eventFor('menu') },
    commands: { onCommand: eventFor('command') },
  });
  Object.assign(browser.runtime, {
    id: RUNTIME_ID,
    getURL: (path: string) => `${ORIGIN}${path}`,
    onStartup: eventFor('startup'),
    onInstalled: eventFor('installed'),
    onMessage: eventFor('message'),
    openOptionsPage: vi.fn(() => Promise.resolve()),
  });
}

const CORE = {
  title: 'bank',
  summary: 'The land beside a river.',
  contextualMeaning: 'Here it is the riverside.',
  definition: 'The raised ground along a river.',
  examples: [{ sentence: 'We sat on the bank.' }, { sentence: 'The bank flooded.' }],
};

/** A hostile Groq error: repeats the key, the prompt and markup. */
const hostile = (message = ''): string =>
  JSON.stringify({
    error: {
      message: `${message} Invalid API Key ${FAKE_KEY}. Authorization: Bearer ${FAKE_KEY}. Selection was ${SELECTED}. <script>alert(1)</script>`,
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
  });

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
  init: RequestInit;
}

type Responder = (call: FetchCall) => Response | Promise<Response>;

interface World {
  /** Deliver a message through the registered runtime.onMessage listener. */
  call(message: unknown, sender: object): Promise<unknown>;
  fetchCalls: FetchCall[];
  chatCalls(): FetchCall[];
  respond: { current: Responder };
  logs: string[];
  broadcasts: unknown[];
  /** Everything in `area`, as text. */
  dump(area: 'local' | 'session' | 'sync'): Promise<string>;
}

const MODELS_RESPONSE = (): Response =>
  new Response(
    JSON.stringify({
      object: 'list',
      data: [{ id: 'openai/gpt-oss-20b', object: 'model', owned_by: 'x', active: true }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const CHAT_OK = (): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(CORE) }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

async function startWorld(): Promise<World> {
  installBrowser();
  resetStorageLockdownForTests();
  const ok = { setAccessLevel: vi.fn(() => Promise.resolve()) };
  await lockDownStorage([ok, ok]);

  const fetchCalls: FetchCall[] = [];
  const respond: { current: Responder } = {
    current: (call) => (call.url.endsWith('/models') ? MODELS_RESPONSE() : CHAT_OK()),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: FetchCall = {
        url: String(url),
        method: init.method ?? 'GET',
        headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
        body: typeof init.body === 'string' ? init.body : undefined,
        signal: init.signal ?? undefined,
        init,
      };
      fetchCalls.push(call);
      return respond.current(call);
    }),
  );

  const logs: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  const broadcasts: unknown[] = [];
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: unknown) => {
    broadcasts.push(message);
    return Promise.resolve(undefined);
  }) as never);

  registerBackground();
  const listener = (listeners.get('message') ?? [])[0] as (
    raw: unknown,
    sender: object,
    respondWith: (r: unknown) => void,
  ) => true | undefined;

  return {
    call: (message, sender) =>
      new Promise((resolve) => {
        const claimed = listener(message, sender, resolve);
        if (claimed !== true) queueMicrotask(() => resolve(undefined));
      }),
    fetchCalls,
    chatCalls: () => fetchCalls.filter((c) => c.url.endsWith('/chat/completions')),
    respond,
    logs,
    broadcasts,
    dump: async (area) => JSON.stringify(await browser.storage[area].get(null)),
  };
}

/** A valid AI_EXPLAIN for `text`. */
const explain = (
  requestId: string = REQ_A,
  text: string = SELECTED,
  extra: object = {},
): object => ({
  v: 1,
  type: 'AI_EXPLAIN',
  payload: {
    requestId,
    snapshot: { selectionId: REQ_B, source: 'webpage', kind: 'word', text },
    mode: 'core',
    detailLevel: 'standard',
  },
  ...extra,
});

const options = (): object => pageSender('/options.html');
const content = (tab = 5): object => contentSender(tab);

const setKey = (w: World, storage: 'local' | 'session' = 'local'): Promise<unknown> =>
  w.call({ v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage }, options());
const ready = async (w: World): Promise<void> => {
  await setKey(w);
  await w.call({ v: 1, type: 'ACCEPT_DISCLOSURE' }, options());
  w.fetchCalls.length = 0;
};

/** Everything the background emitted or stored that must NEVER carry the key or the selection. */
async function expectNoLeaks(w: World, replies: unknown[], label: string): Promise<void> {
  const secrets = [FAKE_KEY, KEY_MIDDLE];
  const bad = (text: string): string[] => secrets.filter((s) => text.includes(s));
  expect(bad(JSON.stringify(replies)), `${label}: replies`).toEqual([]);
  expect(bad(w.logs.join('\n')), `${label}: logs`).toEqual([]);
  expect(w.logs.join('\n'), `${label}: logs carry no selection`).not.toContain(SELECTED);
  expect(bad(JSON.stringify(w.broadcasts)), `${label}: broadcasts`).toEqual([]);
  expect(JSON.stringify(w.broadcasts), `${label}: broadcasts carry no selection`).not.toContain(
    SELECTED,
  );
  expect(bad(await w.dump('sync')), `${label}: storage.sync`).toEqual([]);
  // Every request: the key only as the Authorization bearer of a call to the Groq API.
  for (const call of w.fetchCalls) {
    expect(call.url, label).toMatch(
      /^https:\/\/api\.groq\.com\/openai\/v1\/(models|chat\/completions)$/,
    );
    expect(bad(call.url), `${label}: url`).toEqual([]);
    expect(bad(call.body ?? ''), `${label}: request body`).toEqual([]);
    expect(call.headers['Authorization'], label).toBe(`Bearer ${FAKE_KEY}`);
    for (const [name, value] of Object.entries(call.headers)) {
      if (name !== 'Authorization') expect(bad(value), `${label}: header ${name}`).toEqual([]);
    }
  }
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the key lifecycle through the real listener', () => {
  it('saving a key checks it once, with the key only in the Authorization header, and stores it in exactly one record', async () => {
    const w = await startWorld();
    const reply = await setKey(w);
    expect(reply).toMatchObject({
      ok: true,
      data: { hasKey: true, storage: 'local', verification: 'valid' },
    });
    expect(w.fetchCalls).toHaveLength(1);
    expect(w.fetchCalls[0]).toMatchObject({
      url: 'https://api.groq.com/openai/v1/models',
      method: 'GET',
      init: {
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      },
    });
    // Exactly one stored value holds the key; the metadata record beside it has only the last four.
    const local = (await browser.storage.local.get(null)) as Record<string, unknown>;
    const holders = Object.entries(local).filter(([, v]) => JSON.stringify(v).includes(FAKE_KEY));
    expect(holders.map(([k]) => k)).toEqual([STORAGE_KEYS.apiKey]);
    expect(JSON.stringify(local[STORAGE_KEYS.keyMeta])).toContain(FAKE_KEY.slice(-4));
    expect(JSON.stringify(local[STORAGE_KEYS.keyMeta])).not.toContain(KEY_MIDDLE);
    expect(await w.dump('session')).not.toContain(KEY_MIDDLE);
    await expectNoLeaks(w, [reply], 'set key');
  });

  it('a session-only key never touches storage.local, and sync is never written', async () => {
    const w = await startWorld();
    const reply = await setKey(w, 'session');
    expect(reply).toMatchObject({ ok: true, data: { storage: 'session' } });
    expect(await w.dump('local')).not.toContain(FAKE_KEY.slice(-4));
    expect(await w.dump('local')).not.toContain(KEY_MIDDLE);
    expect(await w.dump('session')).toContain(FAKE_KEY);
    expect(await w.dump('sync')).toBe('{}');
    // Switching to persistent moves it: never in both areas.
    await setKey(w, 'local');
    expect(await w.dump('session')).not.toContain(KEY_MIDDLE);
    expect(await w.dump('local')).toContain(FAKE_KEY);
  });

  it('no public reply, from any sender, ever returns the key: status, public settings and AI status carry flags only', async () => {
    const w = await startWorld();
    await ready(w);
    const replies = [
      await w.call({ v: 1, type: 'GET_KEY_STATUS' }, options()),
      await w.call({ v: 1, type: 'GET_SETTINGS' }, options()),
      await w.call({ v: 1, type: 'GET_PUBLIC_SETTINGS' }, content()),
      await w.call({ v: 1, type: 'GET_AI_STATUS' }, content()),
      await w.call({ v: 1, type: 'GET_AI_STATUS' }, pageSender('/reader.html', 3)),
      await w.call({ v: 1, type: 'GET_PUBLIC_SETTINGS' }, panelSender(5)),
    ];
    for (const reply of replies) expect(reply).toMatchObject({ ok: true });
    expect(await w.call({ v: 1, type: 'GET_PUBLIC_SETTINGS' }, content())).toMatchObject({
      data: { hasKey: true },
    });
    await expectNoLeaks(w, replies, 'status replies');
  });

  it('a content script (and the reader) cannot read, test, replace, remove or clear the key: every attempt is refused and the record is untouched', async () => {
    const w = await startWorld();
    await ready(w);
    const before = await w.dump('local');
    const attempts = [
      { v: 1, type: 'GET_KEY_STATUS' },
      { v: 1, type: 'TEST_API_KEY' },
      { v: 1, type: 'SET_API_KEY', apiKey: 'gsk_TESTattacker00000000000000000', storage: 'local' },
      { v: 1, type: 'REMOVE_API_KEY' },
      { v: 1, type: 'CLEAR_ALL_DATA' },
      { v: 1, type: 'GET_API_KEY' },
    ];
    for (const sender of [content(), pageSender('/reader.html', 3), panelSender(5)]) {
      for (const message of attempts) {
        const reply = await w.call(message, sender);
        if (message.type === 'GET_API_KEY') expect(reply).toBeUndefined();
        else expect(reply).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      }
    }
    expect(await w.dump('local')).toBe(before);
    expect(w.fetchCalls).toHaveLength(0);
  });

  it('removing the key empties both areas and the very next Explain asks to set up, without any request', async () => {
    const w = await startWorld();
    await ready(w);
    await w.call({ v: 1, type: 'REMOVE_API_KEY' }, options());
    for (const area of ['local', 'session'] as const) {
      expect(await w.dump(area), area).not.toContain(KEY_MIDDLE);
    }
    const reply = await w.call(explain(REQ_A), content());
    expect(reply).toMatchObject({ ok: false, error: { code: 'SETUP_REQUIRED' } });
    expect(w.chatCalls()).toHaveLength(0);
  });
});

describe('Explain through the real listener, against a hostile Groq', () => {
  it.each([
    ['HTTP 403', () => new Response(hostile(), { status: 403 }), 403, 'unknown'],
    ['HTTP 500', () => new Response(hostile(), { status: 500 }), 500, undefined],
    [
      'transport',
      () => {
        throw new TypeError('secret transport failure');
      },
      undefined,
      undefined,
    ],
  ] as const)(
    '%s reaches the card model with safe diagnostics',
    async (_label, respond, status, reason) => {
      installCatalog();
      const w = await startWorld();
      await ready(w);
      w.respond.current = respond;
      const raw = await w.call(explain(REQ_A), content());
      const client = interpretReply(raw);
      expect(client).toMatchObject({
        kind: 'error',
        code: 'NETWORK_ERROR',
        ...(status === undefined ? {} : { httpStatus: status }),
        ...(reason === undefined ? {} : { forbiddenReason: reason }),
      });
      if (client.kind !== 'error') throw new Error('expected error');
      const card = toCardError(
        client.code,
        client.retryAfterMs,
        0,
        client.reason,
        client.httpStatus,
        client.forbiddenReason,
      );
      expect(card.httpStatus).toBe(status);
      if (status === 403) expect(card.message).toContain('cannot determine why');
      else if (status === 500) expect(card.message).toContain('HTTP 500');
      else expect(card.message).toContain("can't reach Groq");
      await expectNoLeaks(w, [raw, client, card], _label);
    },
  );

  const STATUS_TO_CODE: [number, string][] = [
    [400, 'MODEL_UNAVAILABLE'],
    [401, 'INVALID_API_KEY'],
    [403, 'NETWORK_ERROR'],
    [404, 'MODEL_UNAVAILABLE'],
    [408, 'TIMEOUT'],
    [413, 'SELECTION_TOO_LONG'],
    [422, 'MODEL_UNAVAILABLE'],
    [429, 'RATE_LIMITED'],
    [500, 'NETWORK_ERROR'],
    [502, 'NETWORK_ERROR'],
    [503, 'NETWORK_ERROR'],
    [504, 'NETWORK_ERROR'],
  ];

  for (const [status, code] of STATUS_TO_CODE) {
    it(`HTTP ${status} -> ${code}: one request, no retry, nothing echoed, settings kept`, async () => {
      const w = await startWorld();
      await ready(w);
      await w.call(
        { v: 1, type: 'UPDATE_PREFERENCES', patch: { readingLevel: 'simple' } },
        options(),
      );
      w.respond.current = () =>
        new Response(hostile(), {
          status,
          headers:
            status === 429 ? { 'retry-after': '7', 'x-echo': FAKE_KEY } : { 'x-echo': FAKE_KEY },
        });
      const reply = (await w.call(explain(REQ_A), content())) as {
        ok: boolean;
        error?: {
          code: string;
          message: string;
          retryAfterMs?: number;
          httpStatus?: number;
          forbiddenReason?: string;
        };
      };
      expect(reply.ok).toBe(false);
      expect(reply.error?.code).toBe(code);
      expect(reply.error?.httpStatus).toBe(status);
      if (status === 403) expect(reply.error?.forbiddenReason).toBe('unknown');
      else expect(reply.error?.forbiddenReason).toBeUndefined();
      if (status === 429) expect(reply.error?.retryAfterMs).toBe(7000);
      else expect(reply.error?.retryAfterMs).toBeUndefined();
      // Exactly one paid request, however long we wait: no automatic retry, no loop.
      expect(w.chatCalls()).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(w.chatCalls()).toHaveLength(1);
      // The reply is the documented envelope and nothing else.
      expect(
        Object.keys(reply.error ?? {}).every((k) =>
          ['code', 'message', 'retryAfterMs', 'reason', 'httpStatus', 'forbiddenReason'].includes(
            k,
          ),
        ),
      ).toBe(true);
      // FR-072: a rejected key is flagged, but the user's settings survive.
      const settings = (await w.call({ v: 1, type: 'GET_SETTINGS' }, options())) as {
        data: { preferences: { readingLevel: string } };
      };
      expect(settings.data.preferences.readingLevel).toBe('simple');
      const keyStatus = (await w.call({ v: 1, type: 'GET_KEY_STATUS' }, options())) as {
        data: { hasKey: boolean; verification: string };
      };
      expect(keyStatus.data.hasKey).toBe(true);
      expect(keyStatus.data.verification).toBe(code === 'INVALID_API_KEY' ? 'invalid' : 'valid');
      await expectNoLeaks(w, [reply, keyStatus], `HTTP ${status}`);
    });
  }

  const BAD_BODIES: [string, () => Response][] = [
    ['not JSON', () => new Response('<html><script>x</script>' + FAKE_KEY, { status: 200 })],
    ['JSON that is not a completion', () => new Response('[1,2,3]', { status: 200 })],
    [
      'a completion whose content is not JSON',
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: `prose ${FAKE_KEY}` } }] }), {
          status: 200,
        }),
    ],
    [
      'a completion of the wrong shape',
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ ...CORE, examples: [] }) } }],
          }),
          { status: 200 },
        ),
    ],
    [
      'a field over its limit',
      () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ ...CORE, summary: 'x'.repeat(10_000) }) } },
            ],
          }),
          { status: 200 },
        ),
    ],
    [
      'a body over the size cap',
      () =>
        new Response(
          '{"choices":[{"message":{"content":"' + 'a'.repeat(2 * 1024 * 1024) + '"}}]}',
          { status: 200 },
        ),
    ],
  ];
  for (const [name, make] of BAD_BODIES) {
    it(`${name} -> INVALID_RESPONSE with one request and no echo`, async () => {
      const w = await startWorld();
      await ready(w);
      w.respond.current = () => make();
      const reply = await w.call(explain(REQ_A), content());
      expect(reply).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } });
      expect(w.chatCalls()).toHaveLength(1);
      await expectNoLeaks(w, [reply], name);
    });
  }

  it('a successful Explain carries the selection in ONE quoted block and the key nowhere but the header; the result has only contract fields', async () => {
    const w = await startWorld();
    await ready(w);
    const reply = (await w.call(explain(REQ_A), content())) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(reply.ok).toBe(true);
    expect(Object.keys(reply.data).sort()).toEqual(
      expect.arrayContaining([
        'mode',
        'model',
        'provider',
        'requestId',
        'selectedText',
        'summary',
        'title',
      ]),
    );
    const call = w.chatCalls()[0]!;
    const body = JSON.parse(call.body ?? '{}') as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(
      user.match(
        new RegExp(`<selected_text_[0-9a-f]{16}>${SELECTED}</selected_text_[0-9a-f]{16}>`, 'g'),
      ),
    ).toHaveLength(1);
    expect(body.messages.find((m) => m.role === 'system')?.content).not.toContain(SELECTED);
    await expectNoLeaks(w, [reply], 'success');
  });

  it('the first Explain without an acknowledged disclosure sends nothing; only a content script can acknowledge it', async () => {
    const w = await startWorld();
    await setKey(w);
    w.fetchCalls.length = 0;
    expect(await w.call(explain(REQ_A), content())).toMatchObject({
      ok: false,
      error: { code: 'SETUP_REQUIRED', reason: 'disclosure' },
    });
    // The popup and Settings (privileged pages) cannot acknowledge on the user's behalf.
    for (const sender of [options(), pageSender('/popup.html', null as never)]) {
      const reply = await w.call(explain(REQ_A, SELECTED, { acknowledgeDisclosure: true }), sender);
      expect(reply, 'acknowledgement from a privileged page').toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    }
    expect(w.chatCalls()).toHaveLength(0);
    expect(
      await w.call(explain(REQ_A, SELECTED, { acknowledgeDisclosure: true }), content()),
    ).toMatchObject({ ok: true });
    expect(w.chatCalls()).toHaveLength(1);
  });
});

describe('cancellation and restart (abuse case 5)', () => {
  /** A Groq that holds the request open until the test lets it go (or the request is aborted). */
  function holding(w: World) {
    const state = { release: () => undefined as void, aborted: false };
    w.respond.current = (call) =>
      call.url.endsWith('/models')
        ? MODELS_RESPONSE()
        : new Promise<Response>((resolve, reject) => {
            state.release = () => resolve(CHAT_OK());
            call.signal?.addEventListener('abort', () => {
              state.aborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
    return state;
  }

  it("AI_CANCEL aborts the sender's own request only; another tab's cancel cannot", async () => {
    const w = await startWorld();
    await ready(w);
    const hold = holding(w);
    const pending = w.call(explain(REQ_A), content(5));
    await vi.waitFor(() => expect(w.chatCalls()).toHaveLength(1));
    // Another tab names the same request id: nothing happens.
    expect(await w.call({ v: 1, type: 'AI_CANCEL', requestId: REQ_A }, content(6))).toMatchObject({
      ok: true,
      data: { cancelled: false },
    });
    expect(hold.aborted).toBe(false);
    expect(await w.call({ v: 1, type: 'AI_CANCEL', requestId: REQ_A }, content(5))).toMatchObject({
      ok: true,
      data: { cancelled: true },
    });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
    expect(hold.aborted).toBe(true);
    expect(w.chatCalls()).toHaveLength(1);
  });

  it('removing or replacing the key, or clearing all data, aborts the request that is using it; nothing is re-sent', async () => {
    for (const action of ['remove', 'replace', 'clear'] as const) {
      const w = await startWorld();
      await ready(w);
      const hold = holding(w);
      const pending = w.call(explain(REQ_A), content());
      await vi.waitFor(() => expect(w.chatCalls()).toHaveLength(1));
      if (action === 'remove') await w.call({ v: 1, type: 'REMOVE_API_KEY' }, options());
      if (action === 'replace') {
        await w.call(
          {
            v: 1,
            type: 'SET_API_KEY',
            apiKey: 'gsk_TESTreplacement0000000000000000',
            storage: 'local',
          },
          options(),
        );
      }
      if (action === 'clear') await w.call({ v: 1, type: 'CLEAR_ALL_DATA' }, options());
      expect(await pending, action).toMatchObject({
        ok: false,
        error: { code: 'REQUEST_CANCELLED' },
      });
      expect(hold.aborted, action).toBe(true);
      expect(w.chatCalls(), action).toHaveLength(1);
    }
  });

  it('a newer request from the same tab supersedes the older one: one in flight, the old one cancelled, two requests in total', async () => {
    const w = await startWorld();
    await ready(w);
    const hold = holding(w);
    const first = w.call(explain(REQ_A), content(5));
    await vi.waitFor(() => expect(w.chatCalls()).toHaveLength(1));
    const second = w.call(explain(REQ_B, 'river'), content(5));
    expect(await first).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
    expect(hold.aborted).toBe(true);
    await vi.waitFor(() => expect(w.chatCalls()).toHaveLength(2));
    hold.release();
    expect(await second).toMatchObject({ ok: true });
  });

  it("after a worker restart nothing is replayed: the old request's late answer reaches nobody, the new worker has no request in flight, and the key still works", async () => {
    const w = await startWorld();
    await ready(w);
    const hold = holding(w);
    const orphan = w.call(explain(REQ_A), content(5));
    await vi.waitFor(() => expect(w.chatCalls()).toHaveLength(1));

    // The worker is terminated: a new one starts over the same extension storage.
    const callsBeforeRestart = w.fetchCalls.length;
    const restarted = await (async () => {
      // Same storage (the old world's areas are still the global fake), new listeners.
      installBrowser();
      resetStorageLockdownForTests();
      const okArea = { setAccessLevel: vi.fn(() => Promise.resolve()) };
      await lockDownStorage([okArea, okArea]);
      registerBackground();
      return (listeners.get('message') ?? [])[0] as (
        raw: unknown,
        sender: object,
        respondWith: (r: unknown) => void,
      ) => true | undefined;
    })();
    // Registering sends nothing by itself.
    expect(w.fetchCalls).toHaveLength(callsBeforeRestart);

    // The old request's answer arrives now: it resolves the OLD listener's pending reply only.
    hold.release();
    expect(await orphan).toMatchObject({ ok: true });
    expect(w.chatCalls()).toHaveLength(1);

    // The new worker serves a fresh request normally (key from storage), counted separately.
    w.respond.current = () => CHAT_OK();
    const reply = await new Promise((resolve) =>
      restarted(explain(REQ_B, 'river'), content(5), resolve),
    );
    expect(reply).toMatchObject({ ok: true });
    expect(w.chatCalls()).toHaveLength(2);
  });
});

describe('the side panel hand-off through the real listener', () => {
  it('is held in memory only: never stored, never logged, and the broadcast that announces it carries only ids', async () => {
    const w = await startWorld();
    await ready(w);
    const handoff = {
      snapshot: { selectionId: REQ_B, source: 'webpage', kind: 'word', text: SELECTED },
      results: [
        { ...CORE, requestId: REQ_A, mode: 'core', provider: 'groq', model: 'openai/gpt-oss-20b' },
      ],
      active: 'core',
    };
    const reply = await w.call({ v: 1, type: 'OPEN_SIDE_PANEL', handoff }, content(5));
    expect(reply).toMatchObject({ ok: true });
    expect(await w.dump('local')).not.toContain(SELECTED);
    expect(await w.dump('session')).not.toContain(SELECTED);
    expect(w.logs.join('\n')).not.toContain(SELECTED);
    expect(w.broadcasts).toEqual([
      { v: 1, type: 'SIDE_PANEL_UPDATED', tabId: 5, revision: expect.any(Number) },
    ]);
    // Only that tab's panel can read it; another tab's panel gets nothing of it.
    const own = await w.call({ v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: 5 }, panelSender(5));
    expect(JSON.stringify(own)).toContain(SELECTED);
    const other = await w.call({ v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: 5 }, panelSender(6));
    expect(other).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(other)).not.toContain(SELECTED);
    // A cleared profile forgets it.
    await w.call({ v: 1, type: 'CLEAR_ALL_DATA' }, options());
    expect(
      JSON.stringify(
        await w.call({ v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: 5 }, panelSender(5)),
      ),
    ).not.toContain(SELECTED);
    await expectNoLeaks(w, [reply], 'side panel');
  });
});

describe('self-check: the leak scan finds a leak when there is one', () => {
  it('flags the key in a log line, a reply, a broadcast, sync storage, a url and a header', async () => {
    const w = await startWorld();
    await ready(w);
    await expectNoLeaks(w, [], 'clean');
    w.logs.push(`oops ${FAKE_KEY}`);
    await expect(expectNoLeaks(w, [], 'log')).rejects.toThrow();
    w.logs.length = 0;
    await expect(
      expectNoLeaks(w, [{ ok: true, data: { key: KEY_MIDDLE } }], 'reply'),
    ).rejects.toThrow();
    w.broadcasts.push({ text: FAKE_KEY });
    await expect(expectNoLeaks(w, [], 'broadcast')).rejects.toThrow();
    w.broadcasts.length = 0;
    await browser.storage.sync.set({ copy: FAKE_KEY });
    await expect(expectNoLeaks(w, [], 'sync')).rejects.toThrow();
    await browser.storage.sync.clear();
    w.fetchCalls.push({
      url: `https://api.groq.com/openai/v1/models?key=${FAKE_KEY}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${FAKE_KEY}` },
      body: undefined,
      signal: undefined,
      init: {},
    });
    await expect(expectNoLeaks(w, [], 'url')).rejects.toThrow();
  });
});
