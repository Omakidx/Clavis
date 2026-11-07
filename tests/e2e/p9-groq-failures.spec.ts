import { expect, test } from '@playwright/test';
import { FAKE_KEY, send } from './p3-support/background';
import { contentWorld } from './p3-support/content-world';
import {
  CARD,
  chatBody,
  explainWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';
import { explainMessage } from './p5-support/groq';
import { cardText, errorShape, installScript, pause, type Script } from './p9-support/card';
import { installLedger, type Ledger } from './p9-support/ledger';
import { stopServiceWorker } from './p9-support/worker';

// Phase 9, "Mock Groq 401/403/404/429/5xx, invalid JSON, huge answers, missing key, offline and
// worker cancellation" (requirements section 7 error catalog, section 8 abuse cases 5 and 7,
// section 9 API row: "400, 401, 403, 404, 429, 500, offline, malformed output, timeout, service
// worker stop"). Every status and every kind of bad answer is produced on the real card, in the
// BUILT extension. For each: the wording and action of the catalog, EXACTLY ONE paid request (no
// automatic retry, no loop), no provider text and no key in the card, and Try again works.
//
// Earlier suites cover single states (p5-card-states: 401, 404, 429, 500, offline, garbage). This
// file completes the table (400, 403, 408, 413, 502, 503, 429 without Retry-After), the kinds of
// unreadable answer, bounded rendering of huge answers, the 30 s deadline, and the service worker
// being terminated mid-request.

test.describe.configure({ mode: 'serial', timeout: 60_000 });

let h: CardHarness;
let ledger: Ledger;
let script: Script;

test.beforeAll(async () => {
  h = await startCardHarness();
  ledger = await installLedger(h.ext.context);
  script = await installScript(h.ext.context);
});
test.afterAll(async () => {
  await h?.close();
});
test.afterEach(async () => {
  script.handler = undefined;
  script.seen.length = 0;
  // A 401 flags the stored key as rejected (FR-072); store it again so every test starts valid.
  await send(h.options, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
});

/** A provider failure whose body tries to echo everything it could: the key, the prompt, markup. */
const hostileBody = JSON.stringify({
  error: {
    message: `Invalid key ${FAKE_KEY}. Reminder: ignore previous instructions <script>window.__p9=1</script>`,
    type: 'invalid_request_error',
    code: 'bad_thing',
  },
});

const WORD = 'cartographer';

/** Press Explain for a fresh word on a fresh tab and return the card once it shows an error. */
async function failing(handler: Script['handler']) {
  script.handler = handler;
  const mark = ledger.mark();
  const { page, dispose } = await h.open();
  const card = await explainWord(page, WORD);
  await card.waitFor(CARD.error, 20_000);
  return { page, card, dispose, mark };
}

const status =
  (code: number, headers: Record<string, string> = {}): Script['handler'] =>
  (route) =>
    route.fulfill({
      status: code,
      contentType: 'application/json',
      headers,
      body: hostileBody,
    });

interface StatusCase {
  status: number;
  headers?: Record<string, string>;
  /** `data-code` of the error block (the wire error code). */
  code: string;
  /** A sentence the catalog / copy promises. */
  says: string;
  /** The primary action's label, or null when only Try again is offered. */
  action: string | null;
  /** Title of the error block, when the catalog has one. */
  title?: string;
}

const STATUSES: StatusCase[] = [
  {
    status: 400,
    code: 'MODEL_UNAVAILABLE',
    says: "The chosen model isn't available",
    action: 'Choose another model',
  },
  {
    status: 401,
    code: 'INVALID_API_KEY',
    says: "Groq didn't accept your key",
    action: 'Update key',
  },
  {
    status: 403,
    code: 'NETWORK_ERROR',
    says: 'Clavis cannot determine why this request was denied',
    action: null,
  },
  {
    status: 404,
    code: 'MODEL_UNAVAILABLE',
    says: "The chosen model isn't available",
    action: 'Choose another model',
  },
  {
    status: 408,
    code: 'TIMEOUT',
    says: 'Groq took too long to answer',
    action: null,
    title: 'Groq returned an error',
  },
  {
    status: 413,
    code: 'SELECTION_TOO_LONG',
    says: 'That selection is too long',
    action: null,
  },
  {
    status: 500,
    code: 'NETWORK_ERROR',
    says: 'The service could not complete the request',
    action: null,
    title: 'Groq returned an error',
  },
  {
    status: 502,
    code: 'NETWORK_ERROR',
    says: 'The service could not complete the request',
    action: null,
    title: 'Groq returned an error',
  },
  {
    status: 503,
    code: 'NETWORK_ERROR',
    says: 'The service could not complete the request',
    action: null,
    title: 'Groq returned an error',
  },
  {
    status: 429,
    code: 'RATE_LIMITED',
    says: "Groq's rate limit was reached",
    action: null,
    title: 'Groq returned an error',
  },
];

test.describe('HTTP statuses on the card', () => {
  for (const c of STATUSES) {
    test(`${c.status}: ${c.says}; one request, no automatic retry, nothing from the provider body shown`, async () => {
      const { page, card, dispose, mark } = await failing(status(c.status, c.headers));
      const shape = await errorShape(card);
      expect(shape.code).toBe(c.code);
      expect(shape.text).toContain(c.says);
      if (c.title !== undefined) expect(shape.text).toContain(c.title);
      const labels = shape.buttons.map((b) => b.label);
      if (c.action !== null) expect(labels).toContain(c.action);
      // The provider's own text and our key never reach the card (the card shows fixed copy).
      const everything = await cardText(card);
      for (const forbidden of [
        FAKE_KEY,
        'ignore previous instructions',
        '<script',
        'Invalid key',
      ]) {
        expect(everything, `card must not show ${forbidden}`).not.toContain(forbidden);
      }
      expect(await page.evaluate(() => (globalThis as { __p9?: number }).__p9)).toBeUndefined();

      // Nothing retries by itself, however long we wait (abuse case 7, NFR "no uncontrolled loops").
      await pause(1500);
      expect(ledger.chats(mark)).toHaveLength(1);
      expect(ledger.models(mark)).toHaveLength(0);

      // A person's Try again is exactly one more request, and it works once Groq recovers.
      script.handler = undefined;
      const retry =
        c.status === 429 ? undefined : shape.buttons.find((b) => b.label === 'Try again');
      if (retry !== undefined) {
        await card.click(CARD.retry);
        await card.waitFor(CARD.ready('core'));
        expect(ledger.chats(mark)).toHaveLength(2);
      }
      await dispose();
    });
  }

  test('429 without a Retry-After header: Try again is available at once and is still one request per press', async () => {
    const { card, dispose, mark } = await failing(status(429));
    const shape = await errorShape(card);
    expect(shape.code).toBe('RATE_LIMITED');
    expect(shape.buttons).toEqual([{ label: 'Try again', inactive: null }]);
    await pause(1200);
    expect(ledger.chats(mark)).toHaveLength(1);
    await card.click(CARD.retry);
    await card.waitFor(CARD.error);
    await pause(800);
    expect(ledger.chats(mark)).toHaveLength(2);
    await dispose();
  });

  test('a 429 with a huge Retry-After is clamped, and an HTTP-date Retry-After is honoured', async () => {
    const huge = await failing(status(429, { 'retry-after': '999999999' }));
    const hugeShape = await errorShape(huge.card);
    // Clamped to one hour: the countdown label never shows an absurd number of seconds.
    expect(hugeShape.buttons[0]?.label).toMatch(/^Try again in \d{1,4} s$/);
    expect(Number(/\d+/.exec(hugeShape.buttons[0]?.label ?? '')?.[0])).toBeLessThanOrEqual(3600);
    expect(hugeShape.buttons[0]?.inactive).toBe('true');
    await huge.dispose();

    const date = new Date(Date.now() + 4000).toUTCString();
    const dated = await failing(status(429, { 'retry-after': date }));
    const datedShape = await errorShape(dated.card);
    expect(datedShape.buttons[0]?.label).toMatch(/^Try again in [1-5] s$/);
    await dated.dispose();
  });
});

test.describe('unreadable answers (error catalog: "Bad/unsafe model JSON")', () => {
  const ok200 =
    (content: string): Script['handler'] =>
    (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: chatBody(content) });

  const goodCore = {
    title: 'bank',
    summary: 'The land beside a river.',
    contextualMeaning: 'Here it is the riverside.',
    definition: 'The raised ground along a river.',
    examples: [{ sentence: 'We sat on the bank.' }, { sentence: 'The bank flooded.' }],
  };

  const CASES: [string, Script['handler']][] = [
    ['plain prose instead of JSON', ok200('Sure! "bank" means the side of a river.')],
    ['a JSON array', ok200('[1, 2, 3]')],
    ['JSON of the wrong shape (missing fields)', ok200(JSON.stringify({ title: 'bank' }))],
    [
      'JSON with the wrong types',
      ok200(JSON.stringify({ ...goodCore, summary: ['not', 'a', 'string'], examples: 'none' })),
    ],
    [
      'three examples where the contract demands two',
      ok200(
        JSON.stringify({
          ...goodCore,
          examples: [{ sentence: 'a' }, { sentence: 'b' }, { sentence: 'c' }],
        }),
      ),
    ],
    [
      'a field longer than its limit (the schema bounds every field)',
      ok200(JSON.stringify({ ...goodCore, summary: 'x'.repeat(5000) })),
    ],
    ['an empty answer', ok200('')],
    [
      'an answer cut off by the token limit',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: '{"title":"bank","summ' },
                finish_reason: 'length',
              },
            ],
          }),
        }),
    ],
    [
      'no choices at all',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [] }),
        }),
    ],
    [
      'an HTML page with status 200 (captive portal, proxy error page)',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><script>window.__p9=1</script><h1>Sign in to Wi-Fi</h1></html>',
        }),
    ],
    [
      'a body far over the size cap (3 MiB)',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: `{"choices":[{"message":{"content":"${'a'.repeat(3 * 1024 * 1024)}"}}]}`,
        }),
    ],
  ];

  for (const [name, handler] of CASES) {
    test(`${name}: "Couldn't format explanation" with Try again; one request; nothing of it is rendered`, async () => {
      const { page, card, dispose, mark } = await failing(handler);
      const shape = await errorShape(card);
      expect(shape.code).toBe('INVALID_RESPONSE');
      expect(shape.text).toContain("Couldn't format explanation");
      expect(shape.buttons.map((b) => b.label)).toEqual(['Try again']);
      const everything = await cardText(card);
      expect(everything).not.toContain('Sign in to Wi-Fi');
      expect(everything).not.toContain('xxxxxxxxxx');
      expect(everything).not.toContain('aaaaaaaaaa');
      expect(await page.evaluate(() => (globalThis as { __p9?: number }).__p9)).toBeUndefined();
      // The page itself never receives any part of the answer either.
      expect(await page.evaluate(() => document.body.innerText)).not.toContain('Sign in to Wi-Fi');
      await pause(1200);
      expect(ledger.chats(mark)).toHaveLength(1);

      script.handler = undefined;
      await card.click(CARD.retry);
      await card.waitFor(CARD.ready('core'));
      expect(ledger.chats(mark)).toHaveLength(2);
      await dispose();
    });
  }

  test('an answer with every field AT its limit is shown inside the window and scrolls in the card (bounded rendering)', async () => {
    const full = {
      title: 'T'.repeat(120),
      summary: 'S'.repeat(600),
      contextualMeaning: 'C'.repeat(800),
      definition: 'D'.repeat(600),
      examples: [
        { sentence: 'E'.repeat(300), note: 'N'.repeat(200) },
        { sentence: 'F'.repeat(300), note: 'N'.repeat(200) },
      ],
      caveat: 'V'.repeat(400),
    };
    script.handler = ok200(JSON.stringify(full));
    const { page, dispose } = await h.open();
    await page.setViewportSize({ width: 640, height: 360 });
    const card = await explainWord(page, WORD);
    await card.waitFor(CARD.ready('core'));
    // The result expands before its ResizeObserver placement runs. Assert the settled visual
    // bounds, rather than combining the new height with the loading card's previous position.
    const box = await card.toolbar.stableBox(CARD.card);
    expect(box.y + box.height).toBeLessThanOrEqual(360 + 1);
    expect(box.x + box.width).toBeLessThanOrEqual(640 + 1);
    // The side panel is suggested for such a long answer (FR-042).
    expect(await card.exists(CARD.longHint)).toBe(true);
    await dispose();
  });
});

test.describe('the envelope a content script receives', () => {
  test('every provider status maps to a fixed code and message; no provider text, key or prompt is echoed', async () => {
    const { page, dispose } = await h.open();
    const world = await contentWorld(page);
    await world.ready();
    const expected: [number, string][] = [
      [400, 'MODEL_UNAVAILABLE'],
      [401, 'INVALID_API_KEY'],
      [403, 'NETWORK_ERROR'],
      [404, 'MODEL_UNAVAILABLE'],
      [408, 'TIMEOUT'],
      [413, 'SELECTION_TOO_LONG'],
      [422, 'MODEL_UNAVAILABLE'],
      [500, 'NETWORK_ERROR'],
      [502, 'NETWORK_ERROR'],
      [503, 'NETWORK_ERROR'],
      [504, 'NETWORK_ERROR'],
    ];
    for (const [code, wire] of expected) {
      script.handler = status(code);
      // A key rejected by Groq is flagged invalid (FR-072); store it again before the next status.
      await send(h.options, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
      const reply = await world.evaluate<unknown>(
        `chrome.runtime.sendMessage(${JSON.stringify(explainMessage('core', { text: 'SELECTIONCANARY' }))})`,
      );
      const text = JSON.stringify(reply);
      expect(reply, `HTTP ${code}`).toMatchObject({ ok: false, error: { code: wire } });
      for (const forbidden of [
        FAKE_KEY,
        'Reminder',
        '<script',
        'Invalid key',
        'SELECTIONCANARY',
        'Bearer',
      ]) {
        expect(text, `HTTP ${code} reply must not carry ${forbidden}`).not.toContain(forbidden);
      }
      // Only the documented fields travel back.
      const error = (reply as { error: Record<string, unknown> }).error;
      expect(Object.keys(error).sort()).toEqual(expect.arrayContaining(['code', 'message']));
      expect(
        Object.keys(error).every((k) =>
          ['code', 'message', 'retryAfterMs', 'reason', 'httpStatus', 'forbiddenReason'].includes(
            k,
          ),
        ),
      ).toBe(true);
      expect(error.httpStatus).toBe(code);
      if (code === 403) expect(error.forbiddenReason).toBe('unknown');
    }
    await world.dispose();
    await dispose();
  });
});

test.describe('cost control (abuse case 7)', () => {
  test('the per-tab throttle: 20 requests a minute, then RATE_LIMITED with a retry delay and NO request to Groq; another tab is unaffected', async () => {
    const { page, dispose } = await h.open();
    const world = await contentWorld(page);
    await world.ready();
    const ask = (): Promise<{ ok: boolean; error?: { code: string; retryAfterMs?: number } }> =>
      world.evaluate(
        `chrome.runtime.sendMessage(${JSON.stringify(explainMessage('core', { text: 'bank' }))})`,
      );
    const mark = ledger.mark();
    for (let i = 0; i < 20; i++) expect((await ask()).ok, `request ${i + 1}`).toBe(true);
    expect(ledger.chats(mark)).toHaveLength(20);
    const throttled = await ask();
    expect(throttled).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    expect(throttled.error?.retryAfterMs).toBeGreaterThan(0);
    expect(throttled.error?.retryAfterMs).toBeLessThanOrEqual(60_000);
    // Refused before anything was sent: still 20 paid requests.
    expect(ledger.chats(mark)).toHaveLength(20);

    // Another tab has its own budget.
    const other = await h.open();
    const otherWorld = await contentWorld(other.page);
    await otherWorld.ready();
    expect(
      await otherWorld.evaluate<{ ok: boolean }>(
        `chrome.runtime.sendMessage(${JSON.stringify(explainMessage('core', { text: 'bank' }))})`,
      ),
    ).toMatchObject({ ok: true });
    await otherWorld.dispose();
    await other.dispose();
    await world.dispose();
    await dispose();
  });
});

test.describe('deadline, offline, service worker and cancellation', () => {
  test('Groq never answers: the worker gives up at its 30 s deadline, the card says so, and nothing is retried', async () => {
    test.setTimeout(100_000);
    let held = 0;
    script.handler = async (route) => {
      held += 1;
      // Never answered; released at the end of the test so the connection does not dangle.
      await new Promise<void>((resolve) => setTimeout(resolve, 45_000));
      await route.abort().catch(() => undefined);
    };
    const mark = ledger.mark();
    const { page, dispose } = await h.open();
    const card = await explainWord(page, WORD);
    await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);
    // A spinner for 30 s at most (requirements: "no infinite spinner").
    await card.waitFor(CARD.error, 40_000);
    const shape = await errorShape(card);
    expect(shape.code).toBe('TIMEOUT');
    expect(shape.text).toContain('Groq took too long to answer');
    expect(shape.buttons.map((b) => b.label)).toContain('Try again');
    expect(held).toBe(1);
    expect(ledger.chats(mark)).toHaveLength(1);
    await pause(1000);
    expect(ledger.chats(mark)).toHaveLength(1);
    await dispose();
  });

  test('the service worker is terminated mid-request (abuse case 5): clear message, Try again, NO duplicate request, a late answer is discarded', async () => {
    let gate: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => (gate = resolve));
    script.handler = async (route) => {
      await opened;
      // The answer of the request that died with the worker: it must never be shown.
      await route
        .fulfill({
          status: 200,
          contentType: 'application/json',
          body: chatBody(
            JSON.stringify({
              title: 'LATEANSWER',
              summary: 'LATEANSWER',
              contextualMeaning: 'LATEANSWER',
              definition: 'LATEANSWER',
              examples: [{ sentence: 'LATEANSWER' }, { sentence: 'LATEANSWER' }],
            }),
          ),
        })
        .catch(() => undefined);
    };
    const mark = ledger.mark();
    const { page, dispose } = await h.open();
    const card = await explainWord(page, WORD);
    await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);
    await expect.poll(() => ledger.chats(mark).length).toBe(1);

    await stopServiceWorker(h.ext.context, h.options);

    // Nobody answers the pending message: the card stops loading and says what happened.
    await card.waitFor(CARD.error, 15_000);
    const shape = await errorShape(card);
    expect(shape.code).toBe('NO_RESPONSE');
    expect(shape.text).toContain("Clavis isn't responding");
    expect(shape.buttons.map((b) => b.label)).toContain('Try again');

    // Whatever Groq says now is for a request nobody is waiting for.
    gate();
    await pause(1500);
    expect(await cardText(card)).not.toContain('LATEANSWER');
    // The dead request was not replayed by anything (UI client, worker start-up, the card).
    expect(ledger.chats(mark)).toHaveLength(1);

    // The user presses Try again: exactly one new request, served by the restarted worker.
    script.handler = undefined;
    await card.click(CARD.retry);
    await card.waitFor(CARD.ready('core'));
    expect(ledger.chats(mark)).toHaveLength(2);
    // The key survived the restart (storage, not worker memory).
    expect(await send(h.options, { v: 1, type: 'GET_KEY_STATUS' })).toMatchObject({
      ok: true,
      data: { hasKey: true },
    });
    await dispose();
  });

  test('the card Close button and removing the key each cancel the in-flight request at the worker (no late result, no orphan call)', async () => {
    const aborted: string[] = [];
    const mark = ledger.mark();
    h.ext.context.on('requestfailed', (request) => {
      if (request.url().includes('api.groq.com')) aborted.push(request.failure()?.errorText ?? '');
    });
    script.handler = async (route) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 6000));
      await route.fallback().catch(() => undefined);
    };

    // 1. Close button of the card while loading.
    let page = (await h.open()).page;
    let card = await explainWord(page, WORD);
    await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);
    await expect.poll(() => ledger.chats(mark).length).toBe(1);
    await card.click(CARD.close);
    await expect.poll(() => aborted.length, { timeout: 8000 }).toBe(1);
    await page.close();

    // 2. Removing the key from Settings while a request is in flight aborts it too (secret boundary
    // rule 6: "aborts in-flight requests").
    const second = await h.open();
    page = second.page;
    card = await explainWord(page, 'river');
    await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);
    await expect.poll(() => ledger.chats(mark).length).toBe(2);
    await send(h.options, { v: 1, type: 'REMOVE_API_KEY' });
    await expect.poll(() => aborted.length, { timeout: 8000 }).toBe(2);
    await card.waitFor(CARD.error);
    await second.dispose();
  });
});
