// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createPreactRenderer } from '../../../components/tooltip/preact-renderer';
import { createToolbar } from '../../../components/tooltip/toolbar';
import { captureSelection, type CapturedSelection } from '../../../lib/selection/capture';
import { createListenController } from '../../../lib/selection/listen';
import * as trust from '../../../lib/selection/trust';
import type {
  ListenReport,
  RunContext,
  ToolbarActions,
  ToolbarHandle,
} from '../../../lib/selection/ui-api';
import { clearSelection, mockRangeRects, selectText, setBody } from '../selection/dom';

// Phase 6: the Listen part of the toolbar shell. States come ONLY from what the action reports.

let toolbar: ToolbarHandle | undefined;
let roots: ShadowRoot[] = [];
const listenRuns: RunContext[] = [];
const explainRuns: RunContext[] = [];
let openedVoiceSettings = 0;
/** What `listen` returns; undefined = it reports through `context.listen` only. */
let listenResult: () => void | Promise<void> = () => undefined;

const actions: ToolbarActions = {
  listen: (context) => {
    listenRuns.push(context);
    return listenResult();
  },
  explain: (context) => {
    explainRuns.push(context);
    return undefined;
  },
  openVoiceSettings: () => void (openedVoiceSettings += 1),
};

const shadow = (): ShadowRoot => roots[0] as ShadowRoot;
const q = (selector: string): HTMLElement | null => shadow().querySelector(selector);
const button = (action: string): HTMLButtonElement =>
  shadow().querySelector(`button[data-action="${action}"]`) as HTMLButtonElement;
const text = (selector: string): string | undefined => q(selector)?.textContent ?? undefined;
const latest = (): RunContext => listenRuns.at(-1) as RunContext;
/** Runs that already reported `starting`: the real controller always does so first. */
const started = new WeakSet<RunContext>();
const report = (value: ListenReport): void => {
  const run = latest();
  if (value.status === 'starting') started.add(run);
  else if (!started.has(run) && value.status !== 'idle') {
    throw new Error(`impossible: ${value.status} reported before starting`);
  }
  run.listen?.report(value);
};
/** What the controller does when audio starts: starting, then playing. */
const play = (remote = false, slow = false): void => {
  report({ status: 'starting' });
  report({ status: 'playing', slow, remote });
};

function capture(value: string): CapturedSelection {
  selectText(value);
  return captureSelection() as CapturedSelection;
}
function create(): ToolbarHandle {
  toolbar = createToolbar(createPreactRenderer(), { actions });
  return toolbar;
}

beforeEach(() => {
  roots = [];
  const attachShadow = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const root = attachShadow.call(this, init);
    roots.push(root);
    return root;
  });
  vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(true);
  vi.useFakeTimers();
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
  vi.spyOn(browser.i18n, 'getMessage').mockImplementation((key: string) => key);
  mockRangeRects([{ left: 300, top: 300, right: 360, bottom: 320, width: 60, height: 20 }]);
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 100 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 40 });
  setBody('<p>The old bank by the river and the old mill.</p><p id="outside">Elsewhere.</p>');
});

afterEach(() => {
  toolbar?.destroy();
  toolbar = undefined;
  listenRuns.length = 0;
  explainRuns.length = 0;
  openedVoiceSettings = 0;
  listenResult = () => undefined;
  clearSelection();
  vi.useRealTimers();
});

describe('Listen states (FR-020..FR-024)', () => {
  it('shows nothing playing until the action reports it: idle -> starting -> playing -> idle', async () => {
    create().show(capture('bank'));
    expect(button('listen').textContent).toBe('toolbarListen');
    button('listen').click();
    // The action has not reported anything yet: no spinner, no Stop, no "playing".
    expect(button('listen').getAttribute('data-state')).toBeNull();

    report({ status: 'starting' });
    // Spinner, but not disabled: a starting Listen can be cancelled (L7).
    expect(button('listen').getAttribute('aria-disabled')).toBeNull();
    expect(button('listen').getAttribute('aria-busy')).toBe('true');
    expect(button('listen').getAttribute('data-state')).toBe('working');
    expect(q('.spinner')).not.toBeNull();
    expect(button('listen').textContent).toBe('speechCancel');
    await vi.advanceTimersByTimeAsync(100);
    expect(text('[data-clavis="live"]')).toBe('speechStarting');

    report({ status: 'playing', slow: false, remote: false });
    expect(button('listen').textContent).toBe('speechStop');
    expect(button('listen').getAttribute('data-state')).toBe('playing');
    expect(button('listen').getAttribute('aria-disabled')).toBeNull();
    expect(q('.spinner')).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(text('[data-clavis="live"]')).toBe('speechPlaying');

    report({ status: 'ended' });
    expect(button('listen').textContent).toBe('speechReplay');
    expect(button('listen').getAttribute('data-state')).toBeNull();
  });

  it('pressing Cancel while starting aborts the run (TTS_STOP), returns to idle and starts nothing new', async () => {
    create().show(capture('bank'));
    button('listen').click();
    report({ status: 'starting' });
    button('listen').click();
    expect(latest().signal.aborted).toBe(true);
    expect(listenRuns).toHaveLength(1);
    expect(button('listen').textContent).toBe('toolbarListen');
    expect(button('listen').getAttribute('data-state')).toBeNull();
    expect(q('.spinner')).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(text('[data-clavis="live"]')).toBe('speechStopped');
    // A late report of the cancelled run changes nothing.
    latest().listen?.report({ status: 'playing', slow: false, remote: false });
    expect(button('listen').textContent).toBe('toolbarListen');
  });

  it('Stop aborts the run (which stops the audio) and returns to idle with an announcement', async () => {
    create().show(capture('bank'));
    button('listen').click();
    play();
    expect(latest().signal.aborted).toBe(false);

    button('listen').click();
    expect(latest().signal.aborted).toBe(true);
    expect(button('listen').textContent).toBe('toolbarListen');
    await vi.advanceTimersByTimeAsync(100);
    expect(text('[data-clavis="live"]')).toBe('speechStopped');
    // No second TTS request was started by Stop.
    expect(listenRuns).toHaveLength(1);
  });

  it('Replay starts a new run for the same selection', () => {
    const captured = capture('bank');
    create().show(captured);
    button('listen').click();
    play();
    report({ status: 'ended' });
    button('listen').click();
    expect(listenRuns).toHaveLength(2);
    expect(listenRuns[1]?.snapshot).toBe(captured.snapshot);
    expect(listenRuns[0]?.signal.aborted).toBe(true);
  });

  it('an ended-by-error playback keeps Replay and says what happened', () => {
    create().show(capture('bank'));
    button('listen').click();
    play();
    report({ status: 'ended', message: 'speechPlaybackError' });
    expect(button('listen').textContent).toBe('speechReplay');
    expect(text('[data-clavis="listen-message"]')).toBe('speechPlaybackError');
  });

  it('no voice: message, hint and a Voice settings action; the Listen button stays usable', async () => {
    create().show(capture('bank'));
    button('listen').click();
    report({ status: 'starting' });
    report({
      status: 'unavailable',
      message: 'speechNoVoice',
      hint: 'speechNoVoiceLinuxHint',
    });
    expect(text('[data-clavis="listen-message"]')).toBe('speechNoVoice');
    expect(text('[data-clavis="listen-hint"]')).toBe('speechNoVoiceLinuxHint');
    expect(button('listen').getAttribute('data-state')).toBeNull();
    expect(button('listen').getAttribute('aria-disabled')).toBeNull();
    expect(q('.spinner')).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(text('[data-clavis="live"]')).toBe('speechNoVoice speechNoVoiceLinuxHint');

    button('voice-settings').click();
    expect(openedVoiceSettings).toBe(1);

    // Pressing Listen again retries (a voice may have been installed meanwhile).
    button('listen').click();
    expect(listenRuns).toHaveLength(2);
  });

  it('a start failure shows its message without a Voice settings button', () => {
    create().show(capture('bank'));
    button('listen').click();
    report({ status: 'starting' });
    report({ status: 'failed', message: 'speechTimedOut' });
    expect(text('[data-clavis="listen-message"]')).toBe('speechTimedOut');
    expect(q('[data-action="voice-settings"]')).toBeNull();
  });

  it('says so on EVERY playback with an online voice, and not for an on-device voice', () => {
    create().show(capture('bank'));
    button('listen').click();
    play(true);
    expect(text('[data-clavis="listen-note"]')).toBe('speechRemoteNote');
    report({ status: 'ended' });
    expect(q('[data-clavis="listen-note"]')).toBeNull();
    button('listen').click();
    play(true);
    expect(text('[data-clavis="listen-note"]')).toBe('speechRemoteNote');
    report({ status: 'ended' });
    button('listen').click();
    play(false);
    expect(q('[data-clavis="listen-note"]')).toBeNull();
  });

  it('ignores reports of a superseded or dismissed run', () => {
    const handle = create();
    handle.show(capture('bank'));
    button('listen').click();
    const first = latest();
    handle.show(capture('river'));
    first.listen?.report({ status: 'playing', slow: false, remote: false });
    expect(button('listen').textContent).toBe('toolbarListen');
    expect(button('listen').getAttribute('data-state')).toBeNull();

    button('listen').click();
    handle.hide();
    latest().listen?.report({ status: 'playing', slow: false, remote: false });
    handle.show(capture('mill'));
    expect(button('listen').textContent).toBe('toolbarListen');
  });

  it('works with a promise: pending is starting, resolving is idle, rejecting is a failure', async () => {
    let settle: () => void = () => undefined;
    listenResult = () => new Promise<void>((resolve) => (settle = resolve));
    create().show(capture('bank'));
    button('listen').click();
    expect(button('listen').getAttribute('data-state')).toBe('working');
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(button('listen').getAttribute('data-state')).toBeNull();

    listenResult = () => Promise.reject(new Error('nope'));
    button('listen').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(text('[data-clavis="listen-message"]')).toBe('toolbarActionFailed');
  });

  it('a throwing action is a failure, not a stuck spinner', async () => {
    listenResult = () => {
      throw new Error('sync');
    };
    create().show(capture('bank'));
    button('listen').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(text('[data-clavis="listen-message"]')).toBe('toolbarActionFailed');
    expect(button('listen').getAttribute('data-state')).toBeNull();
  });

  it('is harmless with no listen action at all', () => {
    toolbar = createToolbar(createPreactRenderer(), {});
    toolbar.show(capture('bank'));
    button('listen').click();
    expect(button('listen').getAttribute('data-state')).toBeNull();
  });
});

describe('Slow toggle', () => {
  it('is a toggle button that applies to the next playback and is remembered for the selection', () => {
    const handle = create();
    handle.show(capture('bank'));
    expect(button('slow').getAttribute('aria-pressed')).toBe('false');
    button('listen').click();
    expect(latest().listen?.slow).toBeUndefined();
    play();
    report({ status: 'ended' });

    button('slow').click();
    expect(button('slow').getAttribute('aria-pressed')).toBe('true');
    button('listen').click();
    expect(latest().listen?.slow).toBe(true);
    play(false, true);
    report({ status: 'ended' });
    // Still on for the next Replay of the same selection.
    button('listen').click();
    expect(latest().listen?.slow).toBe(true);
    play(false, true);
    report({ status: 'ended' });
    button('slow').click();
    expect(button('slow').getAttribute('aria-pressed')).toBe('false');
    button('listen').click();
    expect(latest().listen?.slow).toBe(false);

    // A new selection returns to the preference.
    handle.show(capture('river'));
    expect(button('slow').getAttribute('aria-pressed')).toBe('false');
    button('listen').click();
    expect(latest().listen?.slow).toBeUndefined();
  });

  it('reflects the speed the preference made the playback use', () => {
    create().show(capture('bank'));
    button('listen').click();
    report({ status: 'starting', slow: true });
    expect(button('slow').getAttribute('aria-pressed')).toBe('true');
  });

  it('does not interrupt playback and does not count as a Listen press', () => {
    create().show(capture('bank'));
    button('listen').click();
    play();
    button('slow').click();
    expect(latest().signal.aborted).toBe(false);
    expect(listenRuns).toHaveLength(1);
    expect(button('listen').textContent).toBe('speechStop');
  });
});

describe('Listen and Explain are independent', () => {
  it('pressing Listen leaves an open explanation card alone', () => {
    create().show(capture('bank'));
    button('explain').click();
    const explain = explainRuns[0] as RunContext;
    const opened = explain.surface?.open() ?? null;
    expect(opened).not.toBeNull();
    expect(q('[data-clavis="card-slot"]')).not.toBeNull();

    button('listen').click();
    play();
    expect(explain.signal.aborted).toBe(false);
    expect(q('[data-clavis="card-slot"]')).toBe(opened);
    expect(q('[data-clavis="panel"]')?.getAttribute('data-card')).toBe('explain');
    // Stop does not touch the card either.
    button('listen').click();
    expect(explain.signal.aborted).toBe(false);
    expect(q('[data-clavis="card-slot"]')).toBe(opened);
  });

  it('pressing Explain does not stop playback', () => {
    create().show(capture('bank'));
    button('listen').click();
    play();
    button('explain').click();
    expect(latest().signal.aborted).toBe(false);
    expect(button('listen').textContent).toBe('speechStop');
  });

  it('a new selection, Escape and a press outside all stop playback', () => {
    const handle = create();
    const stops: Array<() => void> = [
      () => handle.show(capture('river')),
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      () =>
        document
          .getElementById('outside')
          ?.dispatchEvent(new Event('pointerdown', { bubbles: true })),
      () => handle.destroy(),
    ];
    for (const stop of stops) {
      handle.show(capture('bank'));
      button('listen').click();
      play();
      const { signal } = latest();
      expect(signal.aborted).toBe(false);
      stop();
      expect(signal.aborted).toBe(true);
    }
  });
});

describe('toolbar with the real Listen controller (what each NO_VOICE reason shows)', () => {
  const REQUEST_ID = '2d8a3a8e-0c1b-4d63-a1de-0f6a9f6f3a11';

  /** A toolbar wired to the real controller; `answer` is what the background says to TTS_SPEAK. */
  function wired(answer: unknown) {
    const sent: Array<Record<string, unknown>> = [];
    const controller = createListenController({
      newId: () => REQUEST_ID,
      send: (message) => {
        const m = message as Record<string, unknown>;
        sent.push(m);
        if (m['type'] === 'TTS_SPEAK') return Promise.resolve(answer);
        return Promise.resolve({ ok: true, data: {} });
      },
    });
    toolbar = createToolbar(createPreactRenderer(), {
      actions: { listen: controller.listen, openVoiceSettings: controller.openVoiceSettings },
    });
    toolbar.show(capture('bank'));
    return { sent, controller };
  }
  const fail = (reason?: string) => ({
    ok: false,
    error: { code: 'NO_VOICE', message: 'x', ...(reason === undefined ? {} : { reason }) },
  });

  it.each([
    ['no-voice-linux', 'speechNoVoice', 'speechNoVoiceLinuxHint', true],
    [undefined, 'speechNoVoice', 'speechNoVoiceHint', true],
    ['some-future-reason', 'speechNoVoice', 'speechNoVoiceHint', true],
    ['no-voice-language', 'speechNoVoiceForLanguage', undefined, true],
    ['online-only', 'speechOnlineOnly', undefined, true],
    ['start-failed', 'speechStartFailed', undefined, false],
  ])(
    'reason %s: message %s, hint %s, Voice settings %s',
    async (reason, message, hint, settings) => {
      wired(fail(reason));
      button('listen').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(text('[data-clavis="listen-message"]')).toBe(message);
      expect(text('[data-clavis="listen-hint"]')).toBe(hint);
      expect(q('[data-action="voice-settings"]') !== null).toBe(settings);
      // Never a dead button or a spinner, and pressing again retries.
      expect(button('listen').getAttribute('data-state')).toBeNull();
      expect(q('.spinner')).toBeNull();
      button('listen').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(text('[data-clavis="listen-message"]')).toBe(message);
    },
  );

  it('a started reply plays, the TTS_EVENT ends it, Replay speaks again', async () => {
    const { sent, controller } = wired({
      ok: true,
      data: { state: 'started', engine: 'chrome-tts', remote: true },
    });
    button('listen').click();
    await vi.advanceTimersByTimeAsync(10);
    expect(button('listen').textContent).toBe('speechStop');
    expect(text('[data-clavis="listen-note"]')).toBe('speechRemoteNote');
    controller.handleEvent({ v: 1, type: 'TTS_EVENT', requestId: REQUEST_ID, state: 'ended' });
    await vi.advanceTimersByTimeAsync(10);
    expect(button('listen').textContent).toBe('speechReplay');
    button('listen').click();
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.filter((m) => m['type'] === 'TTS_SPEAK')).toHaveLength(2);
  });

  it('Cancel while the reply is pending sends TTS_STOP, and a late started reply is stopped too', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const sent: Array<Record<string, unknown>> = [];
    const controller = createListenController({
      newId: () => REQUEST_ID,
      send: (message) => {
        const m = message as Record<string, unknown>;
        sent.push(m);
        return m['type'] === 'TTS_SPEAK'
          ? new Promise((resolve) => (answer = resolve))
          : Promise.resolve({ ok: true, data: {} });
      },
    });
    toolbar = createToolbar(createPreactRenderer(), { actions: { listen: controller.listen } });
    toolbar.show(capture('bank'));
    button('listen').click();
    await vi.advanceTimersByTimeAsync(10);
    expect(button('listen').textContent).toBe('speechCancel');
    button('listen').click();
    expect(sent.filter((m) => m['type'] === 'TTS_STOP')).toHaveLength(1);
    answer({ ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } });
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.filter((m) => m['type'] === 'TTS_STOP').length).toBeGreaterThanOrEqual(2);
    expect(button('listen').textContent).toBe('toolbarListen');
  });
});
