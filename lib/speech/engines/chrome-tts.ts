import { browser } from 'wxt/browser';
import { SPEECH_TIMING } from '../constants';
import type { EngineEvent, EngineSpeakRequest, SpeechEngine, SpeechVoice } from '../types';

/** The slice of `chrome.tts` this engine uses. Narrow so tests can fake it. */
export interface TtsApi {
  getVoices(): Promise<
    {
      voiceName?: string | undefined;
      lang?: string | undefined;
      remote?: boolean | undefined;
      extensionId?: string | undefined;
      eventTypes?: readonly string[] | undefined;
    }[]
  >;
  speak(
    text: string,
    options: {
      lang?: string;
      voiceName?: string;
      extensionId?: string;
      rate: number;
      enqueue: boolean;
      onEvent: (event: { type: string; errorMessage?: string | undefined }) => void;
    },
  ): Promise<void>;
  stop(): void;
  /** Chrome 124+. Fires when the voice list changes (e.g. speech-dispatcher finished loading). */
  onVoicesChanged?:
    | {
        addListener(callback: () => void): void;
        removeListener(callback: () => void): void;
      }
    | undefined;
}

/** Map a chrome.tts event type to a Clavis state. Word/sentence/marker/pause/resume are ignored. */
export function mapTtsEvent(type: string, errorMessage?: string): EngineEvent | undefined {
  switch (type) {
    case 'start':
      return { state: 'started' };
    case 'end':
      return { state: 'ended' };
    case 'interrupted':
    case 'cancelled':
      return { state: 'cancelled' };
    case 'error':
      return { state: 'error', detail: errorMessage ?? 'chrome.tts reported an error' };
    default:
      return undefined;
  }
}

export class ChromeTtsEngine implements SpeechEngine {
  readonly id = 'chrome-tts' as const;

  // After one full wait that still found nothing, an empty list is treated as final so that
  // later requests on a machine without voices are not delayed again. Cleared by `invalidate()`
  // (onVoicesChanged, or Settings asking for a fresh report).
  private waitedForEmptyList = false;

  constructor(
    private readonly tts: TtsApi = browser.tts as unknown as TtsApi,
    private readonly voicesChangedWaitMs: number = SPEECH_TIMING.voicesLoadTimeoutMs,
  ) {}

  private async query(): Promise<SpeechVoice[]> {
    const voices = await this.tts.getVoices();
    return voices.map((voice) => ({
      name: voice.voiceName ?? '',
      lang: voice.lang ?? '',
      remote: voice.remote === true,
      engine: this.id,
      eventTypes: voice.eventTypes,
    }));
  }

  /** What chrome.tts knows right now; never waits. */
  peekVoices(): Promise<SpeechVoice[]> {
    return this.query();
  }

  invalidate(): void {
    this.waitedForEmptyList = false;
  }

  async getVoices(options: { refresh?: boolean } = {}): Promise<SpeechVoice[]> {
    if (options.refresh === true) this.invalidate();
    let voices = await this.query();
    // Chromium on Linux loads speech-dispatcher voices asynchronously, so the very first
    // query can be empty even though voices exist a moment later (onVoicesChanged, Chrome 124+).
    if (voices.length === 0 && !this.waitedForEmptyList && this.tts.onVoicesChanged) {
      await this.waitForVoicesChanged(this.tts.onVoicesChanged);
      voices = await this.query();
      this.waitedForEmptyList = voices.length === 0;
    }
    return voices;
  }

  private waitForVoicesChanged(event: NonNullable<TtsApi['onVoicesChanged']>): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        event.removeListener(done);
        resolve();
      };
      const timer = setTimeout(done, this.voicesChangedWaitMs);
      event.addListener(done);
    });
  }

  async speak(request: EngineSpeakRequest, sink: (event: EngineEvent) => void): Promise<void> {
    // enqueue:false interrupts and flushes, but stop() first makes that explicit
    // and also un-pauses a paused engine (chrome.tts docs).
    this.tts.stop();
    const voice = request.voice;
    await this.tts.speak(request.text, {
      ...(request.lang === undefined ? {} : { lang: request.lang }),
      ...(voice?.name ? { voiceName: voice.name } : {}),
      rate: request.rate,
      enqueue: false,
      onEvent: (event) => {
        const mapped = mapTtsEvent(event.type, event.errorMessage);
        if (mapped !== undefined) sink(mapped);
      },
    });
  }

  // async so a synchronous throw from chrome.tts becomes a rejection the service can absorb.
  async stop(): Promise<void> {
    this.tts.stop();
  }
}
