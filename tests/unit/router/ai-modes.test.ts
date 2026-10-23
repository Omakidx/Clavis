import { AI_RATE_LIMIT } from '../../../lib/config/constants';
import { beforeEach, describe, expect, it } from 'vitest';
import { explainResultSchema, messageReplySchema } from '../../../lib/contracts';
import { FEATURES, MODE_FEATURE_FLAGS } from '../../../lib/config/constants';
import { mayAcknowledgeDisclosure } from '../../../lib/router/handlers/ai';
import { classifySender } from '../../../lib/router/sender';
import {
  FAKE_KEY,
  KEY_MESSAGES,
  ORIGIN,
  REQ_A,
  REQ_B,
  RESULT,
  RUNTIME_ID,
  SETTINGS_MESSAGES,
  contentSender,
  createHarness,
  explainMessage,
  failWith,
  makeReady,
  pageSender,
  popupSender,
  type Harness,
} from './harness';

const options = pageSender('/options.html');
const reply = messageReplySchema(explainResultSchema);

/** An AI_EXPLAIN with the first-send acknowledgement flag. */
const acknowledging = (requestId = REQ_A, over: object = {}) => ({
  ...explainMessage(requestId, over),
  acknowledgeDisclosure: true,
});

describe('AI_EXPLAIN modes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await makeReady(h);
  });

  it.each(['core', 'etymology', 'related_words', 'simplify'] as const)(
    'serves the Must mode %s',
    async (mode) => {
      const result = reply.parse(await h.call(explainMessage(REQ_A, { mode }), contentSender()));
      expect(result).toMatchObject({ ok: true, requestId: REQ_A });
      expect(h.provider.explain.mock.calls[0]![0].mode).toBe(mode);
    },
  );

  it('keeps the Should modes off while their flags are off (INVALID_REQUEST, no provider call)', async () => {
    expect(FEATURES).toEqual({ grammarTab: false, translateTab: false });
    expect(MODE_FEATURE_FLAGS).toEqual({ grammar: 'grammarTab', translate: 'translateTab' });
    for (const [mode, extra] of [
      ['grammar', {}],
      ['translate', { targetLanguage: 'fr' }],
    ] as const) {
      expect(
        await h.call(explainMessage(REQ_A, { mode, ...extra }), contentSender()),
      ).toMatchObject({ ok: false, requestId: REQ_A, error: { code: 'INVALID_REQUEST' } });
    }
    expect(h.provider.explain).not.toHaveBeenCalled();
  });

  it('implements the Should modes behind their flags', async () => {
    const on = createHarness({ features: { grammarTab: true, translateTab: true } });
    await makeReady(on);
    expect(
      await on.call(explainMessage(REQ_A, { mode: 'grammar' }), contentSender()),
    ).toMatchObject({ ok: true });
    await on.call(
      explainMessage(REQ_B, { mode: 'translate', targetLanguage: 'ja' }),
      contentSender(),
    );
    expect(on.provider.explain.mock.calls[1]![0]).toMatchObject({
      mode: 'translate',
      targetLanguage: 'ja',
    });
    // Each flag is independent.
    const grammarOnly = createHarness({ features: { grammarTab: true, translateTab: false } });
    await makeReady(grammarOnly);
    expect(
      await grammarOnly.call(
        explainMessage(REQ_A, { mode: 'translate', targetLanguage: 'ja' }),
        contentSender(),
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('translate without a target language is rejected by the contract, before any work', async () => {
    const on = createHarness({ features: { grammarTab: true, translateTab: true } });
    await makeReady(on);
    expect(
      await on.call(explainMessage(REQ_A, { mode: 'translate' }), contentSender()),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(on.provider.explain).not.toHaveBeenCalled();
  });

  it('checks the rate limit before the mode, so a flagged mode is not a free probe', async () => {
    for (let i = 0; i < AI_RATE_LIMIT.capacity; i++) h.guard.buckets.take('tab:5');
    expect(
      await h.call(explainMessage(REQ_A, { mode: 'grammar' }), contentSender(5)),
    ).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
  });

  it('defaults the language to the preference for every non-translate mode and passes the reading level', async () => {
    await h.call(
      {
        v: 1,
        type: 'UPDATE_PREFERENCES',
        patch: { explanationLanguage: 'es', readingLevel: 'simple' },
      },
      options,
    );
    for (const [i, mode] of (
      ['core', 'etymology', 'related_words', 'simplify'] as const
    ).entries()) {
      await h.call(explainMessage(REQ_A, { mode }), contentSender(10 + i));
    }
    for (const [request, opts] of h.provider.explain.mock.calls) {
      expect(request.targetLanguage).toBe('es');
      expect(opts.readingLevel).toBe('simple');
    }
  });

  it('never retries on its own: one provider call per message, even after a transient failure', async () => {
    h.provider.explain.mockRejectedValue(failWith('NETWORK_ERROR'));
    expect(await h.call(explainMessage(), contentSender())).toMatchObject({
      ok: false,
      error: { code: 'NETWORK_ERROR' },
    });
    expect(h.provider.explain).toHaveBeenCalledTimes(1);
  });
});

describe('first-send disclosure acknowledgement', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await h.call(KEY_MESSAGES['SET_API_KEY'], options); // a key, but onboarding was skipped
  });

  const accepted = async () => (await h.settingsStore.getOnboarding()).disclosureAcceptedAt;

  it('replies SETUP_REQUIRED with reason "disclosure" and sends nothing to Groq', async () => {
    const response = await h.call(explainMessage(), contentSender());
    expect(response).toEqual({
      ok: false,
      requestId: REQ_A,
      error: {
        code: 'SETUP_REQUIRED',
        message: 'Confirm that Clavis may send the selected text to Groq.',
        reason: 'disclosure',
      },
    });
    // The reply matches the public envelope contract.
    expect(reply.safeParse(response).success).toBe(true);
    expect(h.provider.explain).not.toHaveBeenCalled();
    expect(await accepted()).toBeNull();
  });

  it('records the acknowledgement and proceeds when a content script sends the flag', async () => {
    const result = await h.call(acknowledging(), contentSender());
    expect(reply.parse(result)).toEqual({ ok: true, requestId: REQ_A, data: RESULT });
    expect(h.provider.explain).toHaveBeenCalledTimes(1);
    expect(await accepted()).toEqual(expect.any(Number));
    expect(await h.call({ v: 1, type: 'GET_AI_STATUS' }, contentSender())).toMatchObject({
      data: { state: 'ready' },
    });
    // Asked once: later requests need no flag.
    expect(await h.call(explainMessage(REQ_B), contentSender())).toMatchObject({ ok: true });
  });

  it('accepts the flag from the practice page', async () => {
    expect(await h.call(acknowledging(), pageSender('/practice.html', 3))).toMatchObject({
      ok: true,
    });
    expect(await accepted()).not.toBeNull();
  });

  it.each([
    ['the popup', popupSender()],
    ['the options page', pageSender('/options.html')],
    ['the onboarding page', pageSender('/onboarding.html')],
  ])('rejects the flag from %s: nothing recorded, nothing sent', async (_name, sender) => {
    // These pages may not send AI_EXPLAIN at all (audit I1), with or without the flag.
    for (const message of [acknowledging(), explainMessage()]) {
      expect(await h.call(message, sender)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    }
    expect(h.provider.explain).not.toHaveBeenCalled();
    expect(await accepted()).toBeNull();
  });

  it('is not reachable by the offscreen document or a foreign sender', async () => {
    for (const sender of [
      { id: RUNTIME_ID, url: `${ORIGIN}/offscreen.html` },
      { id: 'ffffffffffffffffffffffffffffffff', url: 'https://example.com/', tab: { id: 1 } },
    ]) {
      expect(await h.call(acknowledging(), sender)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    }
    expect(await accepted()).toBeNull();
  });

  it('only a literal true is a valid flag', async () => {
    for (const bad of [false, 'true', 1, null, {}]) {
      const response = await h.call(
        { ...explainMessage(), acknowledgeDisclosure: bad },
        contentSender(),
      );
      expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    }
    expect(await accepted()).toBeNull();
  });

  it('without a key it is still SETUP_REQUIRED (no disclosure marker) and records nothing', async () => {
    const fresh = createHarness();
    const response = await fresh.call(acknowledging(), contentSender());
    expect(response).toMatchObject({ ok: false, error: { code: 'SETUP_REQUIRED' } });
    expect(JSON.stringify(response)).not.toContain('disclosure');
    expect(fresh.provider.explain).not.toHaveBeenCalled();
    expect((await fresh.settingsStore.getOnboarding()).disclosureAcceptedAt).toBeNull();
  });

  it('is ignored once acknowledged: the first time is kept', async () => {
    await h.call(SETTINGS_MESSAGES['ACCEPT_DISCLOSURE'], options);
    const first = await accepted();
    expect(await h.call(acknowledging(), contentSender())).toMatchObject({ ok: true });
    expect(await accepted()).toBe(first);
  });

  it('records the acknowledgement even if the key then turns out to be invalid', async () => {
    h.provider.explain.mockRejectedValueOnce(failWith('INVALID_API_KEY', 401));
    expect(await h.call(acknowledging(), contentSender())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_API_KEY' },
    });
    expect(await accepted()).not.toBeNull();
  });

  it('fails closed with STORAGE_UNAVAILABLE when the acknowledgement cannot be saved', async () => {
    h.local.set.mockRejectedValueOnce(new Error('disk full'));
    expect(await h.call(acknowledging(), contentSender())).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_UNAVAILABLE' },
    });
    expect(h.provider.explain).not.toHaveBeenCalled();
    expect(await accepted()).toBeNull();
  });

  it('never leaks the key in any of these replies', async () => {
    const replies = [
      await h.call(explainMessage(), contentSender()),
      await h.call(acknowledging(REQ_B), contentSender()),
    ];
    expect(JSON.stringify(replies)).not.toContain(FAKE_KEY);
  });
});

describe('who may acknowledge', () => {
  const identity = { runtimeId: RUNTIME_ID, extensionOrigin: ORIGIN };
  it('content scripts, the practice page and the reader (card hosts) only', () => {
    const allowed = (sender: Parameters<typeof classifySender>[0]) =>
      mayAcknowledgeDisclosure(classifySender(sender, identity));
    expect(allowed(contentSender())).toBe(true);
    expect(allowed(pageSender('/reader.html'))).toBe(true);
    expect(allowed(pageSender('/practice.html'))).toBe(true);
    expect(allowed(pageSender('/options.html'))).toBe(false);
    expect(allowed(pageSender('/onboarding.html'))).toBe(false);
    expect(allowed(popupSender())).toBe(false);
    expect(allowed({ id: RUNTIME_ID, url: `${ORIGIN}/offscreen.html` })).toBe(false);
    expect(allowed({ id: 'x', url: 'https://example.com/', tab: { id: 1 } })).toBe(false);
  });
});
