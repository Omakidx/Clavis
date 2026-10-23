import type {
  EngineEvent,
  EngineSpeakRequest,
  SpeechEngine,
  SpeechEngineId,
  SpeechVoice,
} from '../../../lib/speech/types';

export const ID_A = '11111111-1111-4111-8111-111111111111';
export const ID_B = '22222222-2222-4222-8222-222222222222';

export function voice(
  engine: SpeechEngineId,
  lang: string,
  extra: Partial<SpeechVoice> = {},
): SpeechVoice {
  return { name: `${engine}-${lang}`, lang, remote: false, engine, ...extra };
}

/** Scriptable engine: records calls and lets a test push events at will. */
export class FakeEngine implements SpeechEngine {
  voices: SpeechVoice[];
  getVoicesError: Error | undefined;
  speakError: Error | undefined;
  /** When true, speak() automatically reports `started` on the next microtask. */
  autoStart = true;
  /** Milliseconds `getVoices` takes (fake timers), to model slow late-loading engines. */
  getVoicesDelayMs = 0;
  invalidateCalls = 0;
  readonly getVoicesCalls: number[] = [];
  readonly refreshCalls: boolean[] = [];
  readonly speakCalls: EngineSpeakRequest[] = [];
  stopCalls = 0;
  private readonly sinks: ((event: EngineEvent) => void)[] = [];

  constructor(
    readonly id: SpeechEngineId,
    voices: SpeechVoice[] = [],
  ) {
    this.voices = voices;
  }

  getVoices(options: { refresh?: boolean } = {}): Promise<SpeechVoice[]> {
    this.getVoicesCalls.push(Date.now());
    this.refreshCalls.push(options.refresh === true);
    const outcome = this.getVoicesError
      ? Promise.reject(this.getVoicesError)
      : Promise.resolve(this.voices);
    if (this.getVoicesDelayMs === 0) return outcome;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        outcome.then(resolve, reject);
      }, this.getVoicesDelayMs);
    });
  }

  invalidate = (): void => {
    this.invalidateCalls++;
  };

  speak(request: EngineSpeakRequest, sink: (event: EngineEvent) => void): Promise<void> {
    this.speakCalls.push(request);
    this.sinks.push(sink);
    if (this.speakError) return Promise.reject(this.speakError);
    if (this.autoStart) queueMicrotask(() => sink({ state: 'started' }));
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopCalls++;
    return Promise.resolve();
  }

  /** Deliver an event to the latest utterance, or to an earlier one by speak-call index. */
  emit(event: EngineEvent, call = this.sinks.length - 1): void {
    this.sinks[call]?.(event);
  }
}
