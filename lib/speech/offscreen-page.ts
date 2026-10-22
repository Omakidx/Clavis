import { MESSAGE_VERSION } from '../config/constants';
import { logger } from '../security/logger';
import { SPEECH_TIMING } from './constants';
import {
  offscreenCommandSchema,
  type OffscreenAck,
  type OffscreenCommand,
  type OffscreenVoicesReply,
} from './messages';
import { selectVoice } from './voice-selection';
import type { SpeechVoice } from './types';

// Minimal structural types so the page logic can be unit tested without a DOM.
export interface SynthVoiceLike {
  name: string;
  lang: string;
  localService: boolean;
}
export interface SynthUtteranceLike {
  text: string;
  lang: string;
  rate: number;
  voice: SynthVoiceLike | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}
export interface SynthLike {
  getVoices(): SynthVoiceLike[];
  speak(utterance: SynthUtteranceLike): void;
  cancel(): void;
  addEventListener(type: 'voiceschanged', listener: () => void, options?: { once: boolean }): void;
  removeEventListener(type: 'voiceschanged', listener: () => void): void;
}

export interface OffscreenPageDeps {
  runtime: {
    id: string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: { id?: string | undefined; tab?: unknown },
          sendResponse: (response: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
  };
  /** Undefined when the page has no Web Speech support. */
  synth: SynthLike | undefined;
  createUtterance(text: string): SynthUtteranceLike;
  voicesLoadTimeoutMs?: number;
  idleNotifyMs?: number;
}

// Utterances must stay referenced until they finish or Chrome may drop their events.
// `current` holds the single active one.

/**
 * Offscreen document logic (D-07). Runs `speechSynthesis` on command from the
 * background and relays start/end/error events back. Trusts only messages from
 * this extension's own non-tab contexts (the service worker), never content scripts.
 */
export function registerOffscreenSpeech(deps: OffscreenPageDeps): void {
  const { runtime, synth } = deps;
  const voicesTimeoutMs = deps.voicesLoadTimeoutMs ?? SPEECH_TIMING.voicesLoadTimeoutMs;
  const idleNotifyMs = deps.idleNotifyMs ?? SPEECH_TIMING.offscreenSelfIdleNotifyMs;
  let current: { requestId: string; utterance: SynthUtteranceLike } | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // After one full wait that still found nothing, an empty list is almost certainly final
  // (Linux without speech-dispatcher): do not make every later request wait again.
  let waitedForEmptyList = false;

  function armIdleNotice(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      relay({ v: MESSAGE_VERSION, type: 'SPEECH_OFFSCREEN_IDLE' });
    }, idleNotifyMs);
  }

  function relay(message: unknown): void {
    runtime.sendMessage(message).catch(() => {
      // The worker may be asleep or gone; nothing useful to do in a spike.
    });
  }

  function emit(
    requestId: string,
    state: 'started' | 'ended' | 'cancelled' | 'error',
    detail?: string,
  ) {
    relay({
      v: MESSAGE_VERSION,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId,
      state,
      ...(detail === undefined ? {} : { detail }),
    });
    if (state !== 'started') {
      if (current?.requestId === requestId) current = undefined;
      // A late `cancelled` for a replaced utterance must not arm the notice while a newer one plays.
      if (current === undefined) armIdleNotice();
    }
  }

  async function loadVoices(): Promise<SynthVoiceLike[]> {
    if (synth === undefined) return [];
    const immediate = synth.getVoices();
    if (immediate.length > 0 || waitedForEmptyList) return immediate;
    // Chrome loads the list asynchronously; wait for it, but never forever (Linux may have none).
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        synth.removeEventListener('voiceschanged', done);
        resolve();
      };
      const timer = setTimeout(done, voicesTimeoutMs);
      synth.addEventListener('voiceschanged', done, { once: true });
    });
    const loaded = synth.getVoices();
    waitedForEmptyList = loaded.length === 0;
    return loaded;
  }

  function toVoice(voice: SynthVoiceLike): SpeechVoice {
    return {
      name: voice.name,
      lang: voice.lang,
      remote: !voice.localService,
      engine: 'offscreen-web-speech',
    };
  }

  async function getVoices(): Promise<OffscreenVoicesReply> {
    const voices = await loadVoices();
    return {
      ok: true,
      supported: synth !== undefined,
      voices: voices.map((voice) => ({
        name: voice.name,
        lang: voice.lang,
        remote: !voice.localService,
      })),
    };
  }

  async function speak(
    command: Extract<OffscreenCommand, { type: 'SPEECH_OFFSCREEN_SPEAK' }>,
  ): Promise<OffscreenAck> {
    if (synth === undefined) return { ok: false, detail: 'speechSynthesis is not available.' };
    const voices = await loadVoices();
    const selection = selectVoice(voices.map(toVoice), command.lang);
    if (!selection.ok) return { ok: false, detail: `No usable voice (${selection.reason}).` };

    clearTimeout(idleTimer);
    synth.cancel();
    const utterance = deps.createUtterance(command.text);
    if (command.lang !== undefined) utterance.lang = command.lang;
    utterance.rate = command.rate;
    const chosen =
      command.voiceName === undefined
        ? undefined
        : voices.find((voice) => voice.name === command.voiceName);
    if (chosen !== undefined) utterance.voice = chosen;

    const requestId = command.requestId;
    utterance.onstart = () => emit(requestId, 'started');
    utterance.onend = () => emit(requestId, 'ended');
    utterance.onerror = (event) => {
      const reason = event.error ?? 'unknown';
      if (reason === 'canceled' || reason === 'interrupted') emit(requestId, 'cancelled');
      else emit(requestId, 'error', reason);
    };
    current = { requestId, utterance };
    synth.speak(utterance);
    return { ok: true };
  }

  runtime.onMessage.addListener((raw, sender, sendResponse) => {
    // Only handle our own commands; everything else belongs to other listeners.
    if (
      typeof raw !== 'object' ||
      raw === null ||
      (raw as { target?: unknown }).target !== 'offscreen'
    ) {
      return undefined;
    }
    // Content scripts share the extension id; only the worker (no tab) may command us.
    if (sender.id !== runtime.id || sender.tab !== undefined) return undefined;

    const parsed = offscreenCommandSchema.safeParse(raw);
    if (!parsed.success) {
      sendResponse({ ok: false, detail: 'Invalid offscreen command.' } satisfies OffscreenAck);
      return undefined;
    }
    const command = parsed.data;

    switch (command.type) {
      case 'SPEECH_OFFSCREEN_GET_VOICES':
        void getVoices().then(sendResponse);
        return true;
      case 'SPEECH_OFFSCREEN_SPEAK':
        void speak(command)
          .then(sendResponse)
          .catch((error: unknown) => {
            logger.warn('offscreen_speak_failed', { requestId: command.requestId });
            sendResponse({
              ok: false,
              detail: error instanceof Error ? error.message.slice(0, 200) : 'speak failed',
            } satisfies OffscreenAck);
          });
        return true;
      case 'SPEECH_OFFSCREEN_STOP':
        synth?.cancel();
        current = undefined;
        sendResponse({ ok: true } satisfies OffscreenAck);
        armIdleNotice();
        return undefined;
    }
  });

  armIdleNotice();
}
