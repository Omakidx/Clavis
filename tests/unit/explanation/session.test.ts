import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExplainSession,
  REQUEST_TIMEOUT_MS,
  toCardError,
  type SessionState,
} from '../../../components/explanation/session';
import { createFakeBackend, flush, installCatalog, makeSnapshot } from './support';

let ids = 0;
const newId = (): string => `id-${(ids += 1)}`;
let clock = 1_000_000;

function make(kind: Parameters<typeof makeSnapshot>[0] = 'word', options = {}) {
  const fake = createFakeBackend();
  const snapshot = makeSnapshot(kind);
  const session = new ExplainSession({
    snapshot,
    backend: fake.backend,
    newId,
    now: () => clock,
    features: { grammarTab: false, translateTab: false },
    ...options,
  });
  return { ...fake, session, snapshot };
}

beforeEach(() => {
  installCatalog();
  ids = 0;
  clock = 1_000_000;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('core request', () => {
  it('sends exactly one core request on attach and shows loading until it answers', () => {
    const { session, calls } = make();
    session.attach();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toMatchObject({ mode: 'core', detailLevel: 'standard' });
    expect(calls[0]?.acknowledge).toBe(false);
    expect(session.state.entries.core?.status).toBe('loading');
    expect(session.state.live).toBe('Explaining…');
  });

  it('shows the core answer as soon as it arrives', async () => {
    const { session, calls } = make();
    session.attach();
    calls[0]?.succeed();
    await flush();
    expect(session.state.entries.core?.status).toBe('ready');
    expect(session.state.entries.core?.result?.title).toBe('bank (noun)');
    expect(session.state.live).toBe('Explanation ready.');
  });

  it('attach is idempotent and re-attaching the same selection never re-requests', async () => {
    const { session, calls } = make();
    session.attach();
    session.attach();
    expect(calls).toHaveLength(1);
    calls[0]?.succeed();
    await flush();
    session.detach();
    session.attach();
    expect(calls).toHaveLength(1);
    expect(session.state.entries.core?.status).toBe('ready');
  });
});

describe('lazy tabs and cache', () => {
  it('requests a tab only the first time it is opened, then serves the cache', async () => {
    const { session, calls } = make('word');
    session.attach();
    calls[0]?.succeed();
    await flush();

    session.selectTab('etymology');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.request.mode).toBe('etymology');
    calls[1]?.succeed();
    await flush();

    session.selectTab('core');
    session.selectTab('etymology');
    session.selectTab('etymology');
    expect(calls).toHaveLength(2);
    expect(session.state.active).toBe('etymology');
    expect(session.state.entries.etymology?.status).toBe('ready');
  });

  it('does not prefetch: nothing is requested for a tab nobody opened', async () => {
    const { session, calls } = make('word');
    session.attach();
    calls[0]?.succeed();
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(1);
  });

  it('ignores a tab that does not exist for the selection kind or is flagged off', () => {
    const { session, calls } = make('sentence');
    session.attach();
    calls[0]?.succeed();
    session.selectTab('etymology');
    session.selectTab('grammar');
    expect(calls).toHaveLength(1);
    expect(session.state.active).toBe('core');
  });

  it('runs one request at a time: a tab opened meanwhile waits for the one in flight', async () => {
    const { session, calls } = make('phrase');
    session.attach();
    calls[0]?.succeed();
    await flush();
    session.selectTab('related_words');
    session.selectTab('simplify');
    expect(calls).toHaveLength(2);
    expect(session.state.entries.simplify?.status).toBe('queued');
    calls[1]?.succeed();
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls[2]?.request.mode).toBe('simplify');
    expect(session.state.entries.simplify?.status).toBe('loading');
  });

  it('sends the Translate language only for the translation request', async () => {
    const { session, calls } = make('sentence', {
      features: { grammarTab: true, translateTab: true },
      targetLanguage: 'fr',
    });
    session.attach();
    calls[0]?.succeed();
    await flush();
    session.selectTab('translate');
    expect(calls[0]?.request.targetLanguage).toBeUndefined();
    expect(calls[1]?.request).toMatchObject({ mode: 'translate', targetLanguage: 'fr' });
  });

  it('a failed tab shows its own error and is not retried by reopening it', async () => {
    const { session, calls } = make('word');
    session.attach();
    calls[0]?.succeed();
    await flush();
    session.selectTab('etymology');
    calls[1]?.reply({ kind: 'error', code: 'NETWORK_ERROR' });
    await flush();
    expect(session.state.entries.etymology?.status).toBe('error');
    expect(session.state.entries.core?.status).toBe('ready');
    session.selectTab('core');
    session.selectTab('etymology');
    expect(calls).toHaveLength(2);
  });
});

describe('abort, supersede and stale responses', () => {
  it('detach cancels the request in flight with AI_CANCEL and forgets unfinished entries', () => {
    const { session, calls, cancelled } = make();
    session.attach();
    session.detach();
    expect(cancelled).toEqual([calls[0]?.request.requestId]);
    expect(session.state.entries.core).toBeUndefined();
  });

  it('a reply that arrives after detach is ignored, and re-attaching asks again', async () => {
    const { session, calls } = make();
    session.attach();
    session.detach();
    calls[0]?.succeed();
    await flush();
    expect(session.state.entries.core).toBeUndefined();
    session.attach();
    expect(calls).toHaveLength(2);
    expect(session.state.entries.core?.status).toBe('loading');
  });

  it('ignores a late reply for a superseded request (stale requestId)', async () => {
    const { session, calls } = make();
    session.attach();
    session.detach();
    session.attach();
    calls[0]?.succeed();
    await flush();
    expect(session.state.entries.core?.status).toBe('loading');
    calls[1]?.succeed();
    await flush();
    expect(session.state.entries.core?.status).toBe('ready');
    expect(session.state.entries.core?.result?.requestId).toBe(calls[1]?.request.requestId);
  });

  it('treats a result for another request id or mode as an invalid response, not as the answer', async () => {
    const { session, calls } = make();
    session.attach();
    calls[0]?.succeed({ requestId: 'someone-else' });
    await flush();
    expect(session.state.entries.core?.status).toBe('error');
    expect(session.state.entries.core?.error?.code).toBe('INVALID_RESPONSE');
  });

  it('destroy cancels, clears the cache and drops later replies', async () => {
    const { session, calls, cancelled } = make();
    session.attach();
    session.destroy();
    expect(cancelled).toHaveLength(1);
    calls[0]?.succeed();
    await flush();
    expect(session.state.entries.core).toBeUndefined();
  });

  it('keeps finished results when detached and re-attached (same selection)', async () => {
    const { session, calls, cancelled } = make('word');
    session.attach();
    calls[0]?.succeed();
    await flush();
    session.selectTab('etymology');
    session.detach();
    expect(cancelled).toEqual([calls[1]?.request.requestId]);
    expect(session.state.entries.core?.status).toBe('ready');
    expect(session.state.entries.etymology).toBeUndefined();
  });

  it('another selection has its own session and cache', async () => {
    const a = make('word');
    const b = make('word');
    a.session.attach();
    a.calls[0]?.succeed();
    await flush();
    b.session.attach();
    expect(b.calls).toHaveLength(1);
    expect(a.session.selectionId).not.toBe(b.session.selectionId);
  });
});

describe('error states', () => {
  async function failWith(
    reply: Parameters<ReturnType<typeof createFakeBackend>['calls'][0]['reply']>[0],
  ) {
    const made = make();
    made.session.attach();
    made.calls[0]?.reply(reply);
    await flush();
    return { ...made, error: made.session.state.entries.core?.error };
  }

  it.each([
    ['SETUP_REQUIRED', 'connect', 'Connect your Groq key to use Explain.'],
    ['INVALID_API_KEY', 'update-key', "Groq didn't accept your key"],
    ['MODEL_UNAVAILABLE', 'choose-model', "The chosen model isn't available"],
    ['NETWORK_ERROR', 'retry', "Clavis can't reach Groq"],
    ['TIMEOUT', 'retry', 'took too long'],
    ['INVALID_RESPONSE', 'retry', "Clavis couldn't read the answer"],
    ['STORAGE_UNAVAILABLE', 'retry', "Chrome's protected extension storage"],
    ['INTERNAL_ERROR', 'retry', 'Something went wrong'],
    ['PERMISSION_DENIED', 'open-settings', "Chrome didn't allow that"],
    ['NO_RESPONSE', 'retry', "Clavis isn't responding"],
  ] as const)('%s offers %s', async (code, action, text) => {
    const { error } = await failWith({ kind: 'error', code });
    expect(error?.action).toBe(action);
    expect(error?.message).toContain(text);
  });

  it('uses the requirements section 7 headings', async () => {
    expect((await failWith({ kind: 'error', code: 'NETWORK_ERROR' })).error?.title).toBe(
      "Can't connect",
    );
    expect((await failWith({ kind: 'error', code: 'TIMEOUT' })).error?.title).toBe("Can't connect");
    expect((await failWith({ kind: 'error', code: 'INVALID_RESPONSE' })).error?.title).toBe(
      "Couldn't format explanation",
    );
    expect((await failWith({ kind: 'error', code: 'RATE_LIMITED' })).error?.title).toBe(
      'Rate limit reached',
    );
  });

  it('a cancellation we did not ask for can be retried', async () => {
    const { error } = await failWith({ kind: 'error', code: 'REQUEST_CANCELLED' });
    expect(error?.action).toBe('retry');
    // Quiet: no heading, no "error" wording, just a note and a Load button.
    expect(error?.quiet).toBe(true);
    expect(error?.title).toBeNull();
    expect(error?.message).toContain("wasn't loaded");
  });

  it('never shows an error for a cancellation the user caused (stale reply is dropped)', async () => {
    const made = make();
    made.session.attach();
    made.session.detach();
    made.calls[0]?.reply({ kind: 'error', code: 'REQUEST_CANCELLED' });
    await flush();
    expect(made.session.state.entries.core).toBeUndefined();
  });

  it('is never an infinite spinner: a request that never answers times out and can be retried', async () => {
    const { session, calls, cancelled } = make();
    session.attach();
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + 1);
    expect(session.state.entries.core?.status).toBe('error');
    expect(session.state.entries.core?.error?.code).toBe('TIMEOUT');
    expect(cancelled).toEqual([calls[0]?.request.requestId]);
    // The late answer of the abandoned request is not the answer any more.
    calls[0]?.succeed();
    await flush();
    expect(session.state.entries.core?.status).toBe('error');
    expect(session.retry('core')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('a rejected backend promise becomes a retryable error, never an unhandled rejection', async () => {
    const fake = createFakeBackend();
    fake.backend.explain = () => Promise.reject(new Error('boom'));
    const session = new ExplainSession({
      snapshot: makeSnapshot(),
      backend: fake.backend,
      newId,
    });
    session.attach();
    await flush();
    expect(session.state.entries.core?.error?.code).toBe('NO_RESPONSE');
  });
});

describe('retry is never automatic', () => {
  it('an error stays until the user retries, and no second request is sent by itself', async () => {
    const { session, calls } = make();
    session.attach();
    calls[0]?.reply({ kind: 'error', code: 'NETWORK_ERROR' });
    await flush();
    vi.advanceTimersByTime(600_000);
    expect(calls).toHaveLength(1);
    expect(session.retry('core')).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.request.requestId).not.toBe(calls[0]?.request.requestId);
  });

  it('rate limit: Retry is refused until retryAfterMs has elapsed', async () => {
    const { session, calls } = make();
    session.attach();
    calls[0]?.reply({ kind: 'error', code: 'RATE_LIMITED', retryAfterMs: 5000 });
    await flush();
    const error = session.state.entries.core?.error;
    expect(error?.retryAt).toBe(clock + 5000);
    expect(error?.message).toContain('5 seconds');
    expect(session.retry('core')).toBe(false);
    clock += 4999;
    expect(session.retry('core')).toBe(false);
    expect(calls).toHaveLength(1);
    clock += 1;
    expect(session.retry('core')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('only a failed tab with a retry action can be retried', async () => {
    const { session, calls } = make();
    session.attach();
    calls[0]?.reply({ kind: 'error', code: 'INVALID_API_KEY' });
    await flush();
    expect(session.retry('core')).toBe(false);
    expect(session.retry('etymology')).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('first-send confirmation (FR-002, D-16)', () => {
  it('shows the prompt instead of an error and sends nothing more by itself', async () => {
    const { session, calls } = make();
    session.attach();
    calls[0]?.reply({ kind: 'disclosure' });
    await flush();
    expect(session.state.entries.core?.status).toBe('disclosure');
    expect(session.state.live).toContain('Send this to Groq?');
    vi.advanceTimersByTime(600_000);
    expect(calls).toHaveLength(1);
  });

  it('Confirm resends the SAME request with the acknowledgement, once', async () => {
    const { session, calls } = make();
    session.attach();
    calls[0]?.reply({ kind: 'disclosure' });
    await flush();
    expect(session.confirmDisclosure('core')).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.acknowledge).toBe(true);
    expect(calls[1]?.request).toEqual(calls[0]?.request);
    calls[1]?.succeed();
    await flush();
    expect(session.state.entries.core?.status).toBe('ready');
    // Nothing to confirm any more; a later retry never carries the acknowledgement on its own.
    expect(session.confirmDisclosure('core')).toBe(false);
  });

  it('the acknowledgement covers one send only', async () => {
    const { session, calls } = make();
    session.attach();
    calls[0]?.reply({ kind: 'disclosure' });
    await flush();
    session.confirmDisclosure('core');
    calls[1]?.reply({ kind: 'error', code: 'NETWORK_ERROR' });
    await flush();
    session.retry('core');
    expect(calls[2]?.acknowledge).toBe(false);
  });

  it('does not loop when the prompt comes back after it was confirmed', async () => {
    const { session, calls } = make();
    session.attach();
    calls[0]?.reply({ kind: 'disclosure' });
    await flush();
    session.confirmDisclosure('core');
    calls[1]?.reply({ kind: 'disclosure' });
    await flush();
    expect(session.state.entries.core?.status).toBe('error');
    expect(calls).toHaveLength(2);
  });

  it('closing the card (detach) without confirming sends nothing and keeps the prompt for next time', async () => {
    const { session, calls } = make();
    session.attach();
    calls[0]?.reply({ kind: 'disclosure' });
    await flush();
    session.detach();
    expect(calls).toHaveLength(1);
    session.attach();
    expect(calls).toHaveLength(1);
    expect(session.state.entries.core?.status).toBe('disclosure');
  });
});

describe('subscribe and activeText', () => {
  it('notifies listeners with fresh state objects and stops after unsubscribe', async () => {
    const { session, calls } = make();
    const seen: SessionState[] = [];
    const stop = session.subscribe((state) => seen.push(state));
    session.attach();
    calls[0]?.succeed();
    await flush();
    const count = seen.length;
    expect(count).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(count);
    stop();
    session.selectTab('etymology');
    expect(seen).toHaveLength(count);
  });

  it('activeText is the visible result as plain text, null while loading', async () => {
    const { session, calls } = make();
    session.attach();
    expect(session.activeText()).toBeNull();
    calls[0]?.succeed();
    await flush();
    expect(session.activeText()).toContain('bank (noun)');
    expect(session.activeText()).toContain('Examples written by AI:');
  });
});

describe('toCardError', () => {
  it('has no retry time without a delay', () => {
    expect(toCardError('RATE_LIMITED', undefined, 5).retryAt).toBeUndefined();
    expect(toCardError('RATE_LIMITED', 0, 5).retryAt).toBeUndefined();
  });
});

describe('side panel hand-off (FR-042)', () => {
  const resultOf = (
    mode: 'core' | 'etymology' | 'translate',
    requestId = '00000000-0000-4000-8000-0000000000aa',
  ) =>
    ({
      requestId,
      selectedText: 'bank',
      mode,
      title: 'bank',
      summary: 'A summary.',
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
      ...(mode === 'translate' ? { translation: { language: 'French', text: 'banque' } } : {}),
    }) as const;

  it('has nothing to hand over until a tab has loaded', () => {
    const { session } = make();
    expect(session.handoff()).toBeNull();
    session.attach();
    expect(session.handoff()).toBeNull();
  });

  it('hands over the snapshot and the loaded tabs in tab order, never a loading or failed one', async () => {
    const { session, calls, snapshot } = make('word');
    session.attach();
    calls[0]?.succeed();
    await flush();
    session.selectTab('etymology');
    expect(session.handoff()?.results.map((r) => r.mode)).toEqual(['core']);
    calls[1]?.reply({ kind: 'error', code: 'NETWORK_ERROR' });
    await flush();
    session.selectTab('related_words');
    calls[2]?.succeed();
    await flush();
    const handoff = session.handoff();
    expect(handoff?.snapshot).toBe(snapshot);
    expect(handoff?.results.map((r) => r.mode)).toEqual(['core', 'related_words']);
    expect(handoff?.active).toBe('related_words');
    expect(handoff?.results[0]).not.toHaveProperty('selectedText');
    expect(handoff).not.toHaveProperty('targetLanguage');
  });

  it('names the translation language only when a translation is part of it', async () => {
    const { session, calls } = make('sentence', {
      features: { grammarTab: false, translateTab: true },
      targetLanguage: 'fr',
    });
    session.attach();
    calls[0]?.succeed();
    await flush();
    expect(session.handoff()).not.toHaveProperty('targetLanguage');
    session.selectTab('translate');
    calls[1]?.succeed();
    await flush();
    expect(session.handoff()?.targetLanguage).toBe('fr');
  });

  it('seed adopts loaded results without sending anything, and attach({ requestCore: false }) asks for nothing', () => {
    const { session, calls } = make('word');
    session.seed([resultOf('core'), resultOf('etymology')], 'etymology');
    session.attach({ requestCore: false });
    expect(calls).toHaveLength(0);
    expect(session.state.entries.core?.status).toBe('ready');
    expect(session.state.entries.etymology?.status).toBe('ready');
    expect(session.state.active).toBe('etymology');
    // Opening a loaded tab is free (D-05); an unloaded one is requested only when asked for.
    session.selectTab('core');
    expect(calls).toHaveLength(0);
    session.selectTab('related_words');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.mode).toBe('related_words');
  });

  it('without a core result the panel session still waits for the user to ask', () => {
    const { session, calls } = make('word');
    session.seed([resultOf('etymology')]);
    session.attach({ requestCore: false });
    expect(calls).toHaveLength(0);
    expect(session.state.entries.core).toBeUndefined();
  });

  it('seed ignores a mode that is not offered for the selection, keeps what is loaded, replaces an error', async () => {
    const { session, calls } = make('sentence');
    session.seed([resultOf('etymology')]); // Roots is a word/phrase tab
    expect(session.state.entries.etymology).toBeUndefined();
    session.attach();
    calls[0]?.reply({ kind: 'error', code: 'TIMEOUT' });
    await flush();
    expect(session.state.entries.core?.status).toBe('error');
    session.seed([resultOf('core', '00000000-0000-4000-8000-0000000000bb')]);
    expect(session.state.entries.core?.status).toBe('ready');
    session.seed([resultOf('core', '00000000-0000-4000-8000-0000000000cc')]);
    expect(session.state.entries.core?.result?.requestId).toBe(
      '00000000-0000-4000-8000-0000000000bb',
    );
  });

  it('a seeded session never sends again for the seeded modes, even after detach and attach', () => {
    const { session, calls } = make('word');
    session.seed([resultOf('core')]);
    session.attach({ requestCore: false });
    session.detach();
    session.attach();
    expect(calls).toHaveLength(0);
  });
});
