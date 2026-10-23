import type { Frame, Page, Worker } from '@playwright/test';
import { frameOffset } from '../spike-b-support/page';
import { tb, type ToolbarProbe } from '../spike-b-support/toolbar';

/**
 * Selectors of the Phase 6 Listen parts of the toolbar (components/tooltip/view.ts), inside the
 * toolbar's closed root. Read through the DevTools protocol like every other toolbar test.
 */
export const LISTEN = {
  listen: '[data-action="listen"]',
  slow: '[data-action="slow"]',
  voiceSettings: '[data-action="voice-settings"]',
  spinner: '.spinner',
  status: '[data-clavis="listen-status"]',
  message: '[data-clavis="listen-message"]',
  hint: '[data-clavis="listen-hint"]',
  note: '[data-clavis="listen-note"]',
} as const;

export type ListenButton = 'listen' | 'slow' | 'voice-settings' | 'explain';

export class ListenProbe {
  readonly toolbar: ToolbarProbe;
  constructor(
    private readonly page: Page,
    private readonly target: Page | Frame = page,
  ) {
    this.toolbar = tb(target);
  }

  /** Real (trusted) mouse click on a toolbar button, including the ones the base probe lacks. */
  async click(button: ListenButton): Promise<void> {
    const box = await this.toolbar.box(`[data-action="${button}"]`);
    const offset = await frameOffset(this.target);
    await this.page.mouse.click(
      offset.x + box.x + box.width / 2,
      offset.y + box.y + box.height / 2,
    );
  }

  /** The Listen button as the user and a screen reader see it. */
  listenButton(): Promise<
    { label: string; state: string | null; disabled: string | null; spinner: boolean } | undefined
  > {
    return this.toolbar.evalIn(
      LISTEN.listen,
      `function () {
        return {
          label: this.textContent,
          state: this.getAttribute('data-state'),
          disabled: this.getAttribute('aria-disabled'),
          spinner: this.querySelector('.spinner') !== null,
        };
      }`,
    );
  }

  pressed(): Promise<string | null | undefined> {
    return this.toolbar.attr(LISTEN.slow, 'aria-pressed');
  }

  async exists(selector: string): Promise<boolean> {
    return (await this.toolbar.evalIn<boolean>(selector, 'function () { return true; }')) === true;
  }

  /** Wait until `check` holds (poll: the toolbar renders asynchronously). */
  async until<T>(
    read: () => Promise<T>,
    check: (value: T) => boolean,
    what: string,
    timeout = 8000,
  ) {
    const deadline = Date.now() + timeout;
    let last: T | undefined;
    for (;;) {
      try {
        last = await read();
        if (check(last)) return last;
      } catch (error) {
        if (!/Could not find node|No node with given id/.test(String(error))) throw error;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Wait for the Listen button label (Listen, Stop or Replay). */
  waitLabel(label: string, timeout?: number): Promise<unknown> {
    return this.until(
      () => this.listenButton(),
      (b) => b?.label === label,
      `label ${label}`,
      timeout,
    );
  }

  /** Wait for the status text under the toolbar. */
  waitMessage(timeout?: number): Promise<string | undefined> {
    return this.until(
      () => this.toolbar.text(LISTEN.message),
      (text) => text !== undefined && text !== '',
      'a Listen message',
      timeout,
    );
  }
}

export const listenOf = (page: Page, target: Page | Frame = page): ListenProbe =>
  new ListenProbe(page, target);

// ---------------------------------------------------------------------------------------
// A scripted chrome.tts for the positive path (this machine has no voices). Same idea as
// p6-speech-events.spec.ts: `start` after speak, `interrupted` when stopped or replaced, `end`
// when the test says the audio finished. Everything else is the real build.
// ---------------------------------------------------------------------------------------

export interface ScriptedVoice {
  voiceName: string;
  lang: string;
  remote: boolean;
  eventTypes: string[];
}

export const SCRIPTED_VOICES: ScriptedVoice[] = [
  { voiceName: 'Test Voice US', lang: 'en-US', remote: false, eventTypes: ['start', 'end'] },
  { voiceName: 'Test Voice GB', lang: 'en-GB', remote: false, eventTypes: ['start', 'end'] },
  { voiceName: 'Test Voix FR', lang: 'fr-FR', remote: true, eventTypes: ['start', 'end'] },
];

export async function installScriptedTts(
  worker: Worker,
  voices: ScriptedVoice[] = SCRIPTED_VOICES,
): Promise<void> {
  await worker.evaluate((list) => {
    const g = globalThis as unknown as {
      chrome: { tts: Record<string, unknown> };
      __tts?: unknown;
    };
    const state = {
      voices: list,
      calls: [] as { voiceName?: string; lang?: string; rate?: number; chars: number }[],
      stops: 0,
      current: undefined as undefined | ((e: { type: string }) => void),
    };
    g.__tts = state;
    g.chrome.tts['getVoices'] = () => Promise.resolve(state.voices);
    g.chrome.tts['speak'] = (
      text: string,
      opts: {
        voiceName?: string;
        lang?: string;
        rate?: number;
        onEvent: (e: { type: string }) => void;
      },
    ) => {
      state.calls.push({
        ...(opts.voiceName === undefined ? {} : { voiceName: opts.voiceName }),
        ...(opts.lang === undefined ? {} : { lang: opts.lang }),
        ...(opts.rate === undefined ? {} : { rate: opts.rate }),
        chars: text.length,
      });
      const previous = state.current;
      state.current = opts.onEvent;
      previous?.({ type: 'interrupted' });
      const mine = opts.onEvent;
      setTimeout(() => {
        if (state.current === mine) mine({ type: 'start' });
      }, 5);
      return Promise.resolve();
    };
    g.chrome.tts['stop'] = () => {
      state.stops += 1;
      const current = state.current;
      state.current = undefined;
      current?.({ type: 'interrupted' });
    };
  }, voices);
}

export interface ScriptedCall {
  voiceName?: string;
  lang?: string;
  rate?: number;
  chars: number;
}

export const scriptedCalls = (worker: Worker): Promise<ScriptedCall[]> =>
  worker.evaluate(
    () => (globalThis as unknown as { __tts: { calls: ScriptedCall[] } }).__tts.calls,
  );

export const scriptedStops = (worker: Worker): Promise<number> =>
  worker.evaluate(() => (globalThis as unknown as { __tts: { stops: number } }).__tts.stops);

/** The scripted audio finished (what `end` means to Chrome). */
export const finishAudio = (worker: Worker): Promise<void> =>
  worker.evaluate(() => {
    const state = (globalThis as unknown as { __tts: { current?: (e: { type: string }) => void } })
      .__tts;
    const current = state.current;
    state.current = undefined;
    current?.({ type: 'end' });
  });

// ---------------------------------------------------------------------------------------
// The practice page keeps its article in an about:srcdoc frame of the page.
// ---------------------------------------------------------------------------------------

/** The article frame of the practice page, once its text is there. */
export async function articleFrame(page: Page): Promise<Frame> {
  await expectFrame(page);
  const frame = page.frames().find((f) => f.url() === 'about:srcdoc') as Frame;
  await frame.waitForSelector('article p');
  return frame;
}

async function expectFrame(page: Page): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!page.frames().some((f) => f.url() === 'about:srcdoc')) {
    if (Date.now() > deadline) throw new Error('practice article frame never appeared');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A real (trusted) double-click on the `occurrence`-th `word` of the article frame. */
export async function selectArticleWord(
  page: Page,
  frame: Frame,
  word: string,
  occurrence = 0,
): Promise<void> {
  const center = await frame.evaluate(
    ({ word, occurrence }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        let at = text.indexOf(word);
        while (at !== -1) {
          if (seen === occurrence) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + word.length);
            const r = range.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          seen += 1;
          at = text.indexOf(word, at + 1);
        }
      }
      return null;
    },
    { word, occurrence },
  );
  if (center === null) throw new Error(`word not found: ${word}`);
  const box = await (await frame.frameElement()).boundingBox();
  await page.mouse.dblclick((box?.x ?? 0) + center.x, (box?.y ?? 0) + center.y);
  await tb(frame).waitShown();
}
