// @vitest-environment jsdom
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interpretReply, createBackend } from '../../../components/explanation/backend';
import { createExplainCard } from '../../../components/explanation/card';
import { ExplainSession } from '../../../components/explanation/session';
import * as trust from '../../../lib/selection/trust';
import type { CardSurface, RunContext } from '../../../lib/selection/ui-api';
import { createFakeBackend, flush, installCatalog, makeSnapshot, resultFor } from './support';

let ids = 0;
let host: HTMLElement;
let shadow: ShadowRoot;

function run(snapshot = makeSnapshot('word', 'bank')) {
  const controller = new AbortController();
  const slot = document.createElement('section');
  shadow.replaceChildren(slot);
  const surface: CardSurface = {
    keyboard: false,
    open: () => (controller.signal.aborted ? null : slot),
    reposition: () => undefined,
    close: () => controller.abort(),
  };
  const context: RunContext = { snapshot, overLimit: false, signal: controller.signal, surface };
  return { context, slot };
}

function setup(overrides: Parameters<typeof createExplainCard>[0] = {}) {
  const fake = createFakeBackend();
  const card = createExplainCard({
    backend: fake.backend,
    newId: () => `id-${(ids += 1)}`,
    now: () => Date.now(),
    copy: () => Promise.resolve(true),
    features: { grammarTab: false, translateTab: false },
    ...overrides,
  });
  return { fake, card };
}

async function showCore(
  overrides: Parameters<typeof createExplainCard>[0] = {},
  kind: 'word' | 'phrase' | 'sentence' = 'word',
) {
  const { fake, card } = setup(overrides);
  const r = run(makeSnapshot(kind, kind === 'sentence' ? 'A whole sentence here.' : 'bank'));
  await act(async () => {
    await card.present(r.context);
  });
  const button = () => r.slot.querySelector<HTMLButtonElement>('[data-clavis="card-save"]');
  expect(button()).toBeNull(); // nothing to save before the answer
  await act(async () => {
    fake.calls[0]?.succeed();
    await flush();
  });
  await settle();
  return { fake, card, r, button };
}

/** Lets the live region arm itself (80 ms) and the library lookup answer. */
const settle = () =>
  act(async () => {
    vi.advanceTimersByTime(100);
    await flush();
  });

const click = (el: Element | null) =>
  act(async () => {
    (el as HTMLElement).click();
    await flush();
  });

beforeEach(() => {
  installCatalog();
  ids = 0;
  vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(true);
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  shadow = host.attachShadow({ mode: 'open' });
});
afterEach(() => {
  host.remove();
  vi.useRealTimers();
});

describe('the Save button in the card', () => {
  it('appears next to Copy once the core answer is ready, for a word', async () => {
    const { r, button } = await showCore();
    const actions = r.slot.querySelector('.ec__actions')!;
    expect(actions.contains(button())).toBe(true);
    expect(button()?.textContent).toBe('Save word');
    const labels = Array.from(actions.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels.indexOf('Save word')).toBe(labels.indexOf('Copy') + 1);
  });

  it('is there for a phrase and absent for a sentence or a passage', async () => {
    expect((await showCore({}, 'phrase')).button()).not.toBeNull();
    expect((await showCore({}, 'sentence')).button()).toBeNull();
  });

  it('is absent without a library to save to (no words backend)', async () => {
    const { fake, card } = setup();
    delete fake.backend.words;
    const r = run();
    await act(async () => {
      await card.present(r.context);
    });
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    expect(r.slot.querySelector('[data-clavis="card-save"]')).toBeNull();
  });

  it("saves the selection and only the core answer's fields, shows Saved and announces it", async () => {
    const { fake, r, button } = await showCore();
    await click(button());
    expect(fake.saves).toHaveLength(1);
    const [saved] = fake.saves;
    expect(saved!.snapshot).toMatchObject({
      text: 'bank',
      kind: 'word',
      contextBefore: 'They sat on the ',
    });
    expect(saved!.meaning).toEqual({
      title: 'bank (noun)',
      summary: 'The land beside a river.',
      contextualMeaning: 'Here it means the edge of the river, not a money bank.',
      definition: 'Sloping ground along the side of a river.',
      examples: [
        { sentence: 'We fished from the bank.', note: 'riverside' },
        { sentence: 'The grass on the bank was wet.' },
      ],
      caveat: 'Other senses exist.',
      model: 'openai/gpt-oss-20b',
    });
    expect(saved!.pdf).toBeUndefined();
    expect(button()?.textContent).toBe('Saved');
    expect(r.slot.querySelector('[data-clavis="card-live"]')?.textContent).toBe(
      'Saved to your library.',
    );
  });

  it('removes the word again when pressed while saved', async () => {
    const { fake, r, button } = await showCore();
    await click(button());
    await click(button());
    expect(fake.removed).toEqual(['k'.repeat(64)]);
    expect(button()?.textContent).toBe('Save word');
    expect(r.slot.querySelector('[data-clavis="card-live"]')?.textContent).toBe(
      'Removed from your saved words.',
    );
  });

  it('starts as Saved when the word is already in the library', async () => {
    const { fake, card } = setup();
    fake.library.set('bank', 'k'.repeat(64));
    const r = run();
    await act(async () => {
      await card.present(r.context);
    });
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    await settle();
    expect(r.slot.querySelector('[data-clavis="card-save"]')?.textContent).toBe('Saved');
  });

  it('says when saving failed or the library is full, and stays unsaved', async () => {
    const { fake, r, button } = await showCore();
    fake.saving.outcome = { ok: false, reason: 'failed' };
    await click(button());
    expect(button()?.textContent).toBe('Save word');
    expect(r.slot.querySelector('[data-clavis="card-live"]')?.textContent).toBe(
      "Couldn't save this word. Try again.",
    );
    fake.saving.outcome = { ok: false, reason: 'limit' };
    await click(button());
    expect(r.slot.querySelector('[data-clavis="card-live"]')?.textContent).toBe(
      'Your library is full. Delete a saved word first.',
    );
  });

  it('acts only on a trusted click (a page cannot press it)', async () => {
    const { fake, button } = await showCore();
    vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(false);
    await click(button());
    expect(fake.saves).toEqual([]);
  });

  it('passes the PDF the reader is showing, read when the word is saved', async () => {
    let title: string | null = 'First';
    const { fake, button } = await showCore({
      pdf: () => ({ fingerprint: 'e'.repeat(64), title }),
    });
    title = 'Second';
    await click(button());
    expect(fake.saves[0]!.pdf).toEqual({ fingerprint: 'e'.repeat(64), title: 'Second' });
  });

  it('is not offered inside a lookup of generated text (not a word the user read)', async () => {
    const { fake, card, r } = await showCore();
    const leaf = r.slot.querySelector<HTMLElement>('[data-clavis="card-result-text"]')!;
    const range = document.createRange();
    range.setStart(leaf.firstChild!, 0);
    range.setEnd(leaf.firstChild!, 3);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const contained = await import('../../../lib/selection/contained-range');
    vi.spyOn(contained, 'selectionWithin').mockReturnValue(range);
    await act(() => {
      leaf.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await act(() => {
      (r.slot.querySelector('[data-clavis="card-lookup"]') as HTMLElement).click();
    });
    await act(async () => {
      fake.calls[1]?.succeed();
      await flush();
    });
    expect(card).toBeDefined();
    expect(r.slot.querySelector('[data-clavis="card-back"]')).not.toBeNull();
    expect(r.slot.querySelector('[data-clavis="card-save"]')).toBeNull();
  });
});

describe('ExplainSession.savable', () => {
  const make = (kind: 'word' | 'sentence', text: string) =>
    new ExplainSession({
      snapshot: makeSnapshot(kind, text),
      backend: createFakeBackend().backend,
      newId: () => `id-${(ids += 1)}`,
      features: { grammarTab: false, translateTab: false },
    });

  it('is null until the core answer is ready, and null for over-long text', () => {
    const session = make('word', 'bank');
    expect(session.savable()).toBeNull();
    const long = make('word', 'x'.repeat(201));
    long.seed([
      resultFor({
        requestId: 'r',
        snapshot: makeSnapshot('word', 'x'),
        mode: 'core',
        detailLevel: 'standard',
      }),
    ]);
    expect(long.savable()).toBeNull();
  });

  it('drops every field the shared meaning does not have', () => {
    const session = make('word', 'bank');
    session.seed([
      {
        ...resultFor({
          requestId: 'r',
          snapshot: makeSnapshot('word', 'bank'),
          mode: 'core',
          detailLevel: 'standard',
        }),
        etymology: { overview: 'x', confidence: 'known' },
        selectedText: 'bank',
      } as never,
    ]);
    const meaning = session.savable()?.meaning;
    expect(Object.keys(meaning ?? {}).sort()).toEqual([
      'caveat',
      'contextualMeaning',
      'definition',
      'examples',
      'model',
      'summary',
      'title',
    ]);
  });
});

describe('the card backend (zod-free messages)', () => {
  const send = vi.fn();
  const backend = () => createBackend(send).words!;
  beforeEach(() => send.mockReset());

  it('sends SAVE_WORD with the snapshot, the meaning and the pdf part, and never a source', async () => {
    send.mockResolvedValueOnce({ ok: true, data: { wordKey: 'a'.repeat(64) } });
    const snapshot = makeSnapshot('word', 'bank');
    const out = await backend().save(
      snapshot,
      { title: 't', summary: 's', model: 'm' },
      { fingerprint: null, title: 'P' },
    );
    expect(out).toEqual({ ok: true, wordKey: 'a'.repeat(64) });
    expect(send).toHaveBeenCalledWith({
      v: 1,
      type: 'SAVE_WORD',
      snapshot,
      meaning: { title: 't', summary: 's', model: 'm' },
      pdf: { fingerprint: null, title: 'P' },
    });
    expect(JSON.stringify(send.mock.calls[0])).not.toContain('"source":{');
  });

  it('maps LIMIT_EXCEEDED, other errors and silence', async () => {
    const snapshot = makeSnapshot('word', 'bank');
    const meaning = { title: 't', summary: 's', model: 'm' };
    send.mockResolvedValueOnce({ ok: false, error: { code: 'LIMIT_EXCEEDED' } });
    expect(await backend().save(snapshot, meaning)).toEqual({ ok: false, reason: 'limit' });
    send.mockResolvedValueOnce({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await backend().save(snapshot, meaning)).toEqual({ ok: false, reason: 'failed' });
    send.mockRejectedValueOnce(new Error('Receiving end does not exist'));
    expect(await backend().save(snapshot, meaning)).toEqual({ ok: false, reason: 'failed' });
  });

  it('asks GET_WORD_SAVED and UNSAVE_WORD with plain fields', async () => {
    send.mockResolvedValueOnce({ ok: true, data: { saved: true, wordKey: 'a'.repeat(64) } });
    expect(await backend().lookup('bank')).toEqual({ saved: true, wordKey: 'a'.repeat(64) });
    expect(send).toHaveBeenLastCalledWith({ v: 1, type: 'GET_WORD_SAVED', text: 'bank' });
    send.mockResolvedValueOnce(undefined);
    expect(await backend().lookup('bank')).toBeNull();
    send.mockResolvedValueOnce({ ok: true, data: { removed: true } });
    expect(await backend().remove('a'.repeat(64))).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ v: 1, type: 'UNSAVE_WORD', wordKey: 'a'.repeat(64) });
  });

  it('interpretReply is unchanged for explain replies', () => {
    expect(interpretReply(undefined)).toEqual({ kind: 'error', code: 'NO_RESPONSE' });
  });
});
