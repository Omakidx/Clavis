import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { browser } from 'wxt/browser';
import { LIMITS, TTS_RATES } from '../../lib/config/constants';
import { t } from '../../lib/i18n';
import type { PdfReaderController } from '../../lib/pdf/controller';
import {
  nextNarrationChunk,
  narrationParagraph,
  narrationWord,
  type NarrationChunk,
} from '../../lib/pdf/narration';
import { parseReaderSpeechEvent, readerSpeech } from '../../lib/pdf/reader-speech';
import { normalizeKangxiRadicals } from '../../lib/pdf/radicals';
import {
  captureReaderTextSelection,
  readerTextRange,
  type ReaderPageText,
  type ReaderTextSection,
  type ReaderTextSelection,
} from '../../lib/pdf/reader-text';
import { isFromBackground, type SenderLike } from './selection-toolbar';
import { useReaderTextVersion } from './useReaderTextVersion';

export type NarrationStatus = 'idle' | 'preparing' | 'playing' | 'paused' | 'complete' | 'error';
export type NarrationScope = 'whole' | 'selection' | 'range';

interface Session {
  version: number;
  lastPage: number;
  page: number;
  offset: number;
  selected: ReaderTextSelection[] | null;
  segment: number;
  rate: number;
  lang?: string;
  spoke: boolean;
}

interface Utterance {
  id: string;
  chunk: NarrationChunk;
  page: number;
  model: ReaderPageText;
  finish: (state: 'ended' | 'cancelled' | 'error') => void;
  result: Promise<'ended' | 'cancelled' | 'error'>;
  hadBoundary: boolean;
  lastWord: ReaderTextSection | null;
}

interface HighlightPosition {
  model: ReaderPageText;
  passage: ReaderTextSection;
  word: ReaderTextSection | null;
}

export interface ReaderNarration {
  status: NarrationStatus;
  page: number;
  rate: number;
  follow: boolean;
  timingUnavailable: boolean;
  error: string | null;
  start(scope: NarrationScope, fromPage: number, toPage: number): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(rate: number): void;
  setFollow(follow: boolean): void;
}

function highlightRegistry(): Map<string, Highlight> | null {
  if (typeof CSS === 'undefined' || typeof Highlight === 'undefined') return null;
  const css = CSS as typeof CSS & { highlights?: Map<string, Highlight> };
  return css.highlights ?? null;
}

export function useReaderNarration(
  controller: PdfReaderController,
  containerRef: RefObject<HTMLDivElement | null>,
  documentKey: number,
  renderCount: number,
  pageCount: number,
): ReaderNarration {
  const [status, setStatus] = useState<NarrationStatus>('idle');
  const [page, setPage] = useState(1);
  const [rate, setRateState] = useState(1);
  const [follow, setFollowState] = useState(true);
  const [timingUnavailable, setTimingUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<HighlightPosition | null>(null);
  const textVersion = useReaderTextVersion(containerRef);
  const session = useRef<Session | null>(null);
  const utterance = useRef<Utterance | null>(null);
  const rateChoice = useRef<number | null>(null);
  const followRef = useRef(true);
  const manualHold = useRef(false);
  const serial = useRef(0);

  const cancelUtterance = useCallback(() => {
    const current = utterance.current;
    if (!current) return;
    utterance.current = null;
    current.finish('cancelled');
    void readerSpeech.stopSpeaking(current.id);
  }, []);

  const stop = useCallback(() => {
    serial.current++;
    const current = session.current;
    if (current) current.version++;
    session.current = null;
    cancelUtterance();
    setPosition(null);
    setError(null);
    setStatus('idle');
  }, [cancelUtterance]);

  // A document replacement is synchronous with the Open action, before the old PDF is closed.
  // Cleanup also covers tab close and navigation away.
  useEffect(() => {
    const onHide = () => stop();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      stop();
    };
  }, [documentKey, stop]);

  useEffect(() => {
    const onMessage = (message: unknown, sender: SenderLike | undefined) => {
      if (!isFromBackground(sender)) return undefined;
      const current = utterance.current;
      if (!current) return undefined;
      const event = parseReaderSpeechEvent(message);
      if (!event || event.requestId !== current.id) return undefined;
      if (event.type === 'TTS_BOUNDARY') {
        const word = narrationWord(current.chunk, event.charIndex, event.length);
        if (!word) return undefined;
        current.hadBoundary = true;
        current.lastWord = word;
        setTimingUnavailable(false);
        const passage = narrationParagraph(current.model, word.start) ?? current.chunk;
        setPosition({ model: current.model, passage, word });
        return undefined;
      }
      if (event.type === 'TTS_EVENT') {
        current.finish(event.state);
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  const play = useCallback(
    async (run: Session) => {
      const version = run.version;
      const valid = () => session.current === run && run.version === version;
      while (valid() && run.page <= run.lastPage) {
        const model = await controller.readPageText(run.page).catch(() => null);
        if (!valid()) return;
        if (!model) {
          setError(t('readerListenExtractError'));
          setStatus('error');
          return;
        }
        if (
          followRef.current &&
          !manualHold.current &&
          controller.getSnapshot().view?.page !== run.page
        ) {
          controller.goToPage(run.page);
        }
        const segment = run.selected?.[run.segment];
        const end = segment ? segment.end : model.text.length;
        const start = segment ? Math.max(run.offset, segment.start) : run.offset;
        const chunk = nextNarrationChunk(model, start, end);
        if (!chunk) {
          if (run.selected) {
            run.segment++;
            const next = run.selected[run.segment];
            if (!next) break;
            run.page = next.page;
            run.offset = next.start;
          } else {
            run.page++;
            run.offset = 0;
          }
          continue;
        }

        run.spoke = true;
        setPage(run.page);
        setPosition({
          model,
          passage: narrationParagraph(model, chunk.start) ?? chunk,
          word: null,
        });
        const id = crypto.randomUUID();
        let finish!: Utterance['finish'];
        const result = new Promise<'ended' | 'cancelled' | 'error'>((resolve) => {
          finish = resolve;
        });
        const active: Utterance = {
          id,
          chunk,
          page: run.page,
          model,
          finish,
          result,
          hadBoundary: false,
          lastWord: null,
        };
        utterance.current = active;
        const pageLang =
          model.lang &&
          model.lang.length <= LIMITS.maxLanguageTagChars &&
          /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(model.lang)
            ? model.lang
            : undefined;
        const reply = await readerSpeech
          .speak({
            requestId: id,
            // This compatibility repair preserves UTF-16 offsets used by live word tracking.
            text: normalizeKangxiRadicals(chunk.text),
            rate: run.rate,
            ...((pageLang ?? run.lang) ? { lang: pageLang ?? run.lang } : {}),
            trackWords: true,
          })
          .catch(() => null);
        if (!valid() || utterance.current !== active) {
          if (reply?.ok) void readerSpeech.stopSpeaking(id);
          return;
        }
        if (!reply?.ok) {
          // A lost reply can hide a speech request that did start. Always stop this ID.
          void readerSpeech.stopSpeaking(id);
          utterance.current = null;
          setError(
            reply?.error.code === 'NO_VOICE'
              ? t('readerListenNoVoice')
              : (reply?.error.message ?? t('readerListenErrorDetail')),
          );
          setStatus('error');
          return;
        }
        setStatus('playing');
        if (!active.hadBoundary) setTimingUnavailable(true);
        // A missing terminal event must never silently move to the next page.
        const watchdog = window.setTimeout(
          () => {
            active.finish('error');
            void readerSpeech.stopSpeaking(id);
          },
          Math.min(10 * 60_000, Math.max(30_000, (chunk.text.length * 200) / run.rate + 15_000)),
        );
        const terminal = await result;
        window.clearTimeout(watchdog);
        if (!valid() || utterance.current !== active) return;
        utterance.current = null;
        if (terminal !== 'ended') {
          setError(t('readerListenErrorDetail'));
          setStatus('error');
          return;
        }
        if (!active.hadBoundary) setTimingUnavailable(true);
        run.offset = chunk.end;
      }
      if (!valid()) return;
      setPosition(null);
      setStatus(run.spoke ? 'complete' : 'error');
      if (!run.spoke) setError(t('readerListenNoText'));
      session.current = null;
    },
    [controller],
  );

  const start = useCallback(
    async (scope: NarrationScope, fromPage: number, toPage: number) => {
      stop();
      if (!pageCount) return;
      const serialNow = serial.current;
      setStatus('preparing');
      setTimingUnavailable(false);
      manualHold.current = false;
      let selected: ReaderTextSelection[] | null = null;
      if (scope === 'selection') {
        const container = containerRef.current;
        try {
          selected = container
            ? await captureReaderTextSelection(container, (p) => controller.readPageText(p))
            : [];
        } catch {
          if (serial.current === serialNow) {
            setError(t('readerListenExtractError'));
            setStatus('error');
          }
          return;
        }
        if (serial.current !== serialNow) return;
        if (selected.length === 0) {
          setError(t('readerListenNoSelection'));
          setStatus('error');
          return;
        }
      }
      if (
        scope === 'range' &&
        (!Number.isInteger(fromPage) ||
          !Number.isInteger(toPage) ||
          fromPage < 1 ||
          toPage > pageCount ||
          fromPage > toPage)
      ) {
        setError(t('readerListenRangeError'));
        setStatus('error');
        return;
      }
      const settings = await readerSpeech.getPublicSettings().catch(() => null);
      if (serial.current !== serialNow) return;
      if (!settings?.ok) {
        setError(t('readerListenSettingsError'));
        setStatus('error');
        return;
      }
      const preferred = rateChoice.current ?? settings.data.ttsRate;
      setRateState(preferred);
      const firstPage = selected ? selected[0]!.page : scope === 'range' ? fromPage : 1;
      const lastPage = selected
        ? selected[selected.length - 1]!.page
        : scope === 'range'
          ? toPage
          : pageCount;
      const run: Session = {
        version: 0,
        lastPage,
        page: firstPage,
        offset: selected ? selected[0]!.start : 0,
        selected,
        segment: 0,
        rate: preferred,
        ...(settings.data.ttsLang ? { lang: settings.data.ttsLang } : {}),
        spoke: false,
      };
      session.current = run;
      setPage(firstPage);
      void play(run);
    },
    [stop, pageCount, containerRef, controller, play],
  );

  const pause = useCallback(() => {
    const run = session.current;
    if (!run) {
      // Preparing may still be awaiting selection capture or settings. Cancel that pending start.
      stop();
      return;
    }
    run.version++;
    const current = utterance.current;
    if (current) {
      // Resume at the last real word boundary, or replay this chunk when the voice has none.
      run.offset = current.lastWord?.start ?? current.chunk.start;
    }
    cancelUtterance();
    setStatus('paused');
  }, [cancelUtterance, stop]);

  const resume = useCallback(() => {
    const run = session.current;
    if (!run) return;
    run.rate = rateChoice.current ?? rate;
    setStatus('preparing');
    void play(run);
  }, [play, rate]);

  const setRate = useCallback(
    (next: number) => {
      if (!Number.isFinite(next) || next < TTS_RATES.min || next > TTS_RATES.max) return;
      rateChoice.current = next;
      setRateState(next);
      const run = session.current;
      if (!run) return;
      const wasPlaying = status === 'playing' || status === 'preparing';
      pause();
      run.rate = next;
      if (wasPlaying) {
        setStatus('preparing');
        void play(run);
      }
    },
    [pause, play, status],
  );

  const setFollow = useCallback((next: boolean) => {
    followRef.current = next;
    manualHold.current = false;
    setFollowState(next);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const hold = () => {
      manualHold.current = true;
    };
    container.addEventListener('wheel', hold, { passive: true });
    container.addEventListener('touchstart', hold, { passive: true });
    container.addEventListener('pointerdown', hold, { passive: true });
    container.addEventListener('keydown', hold);
    return () => {
      container.removeEventListener('wheel', hold);
      container.removeEventListener('touchstart', hold);
      container.removeEventListener('pointerdown', hold);
      container.removeEventListener('keydown', hold);
    };
  }, [containerRef]);

  useEffect(() => {
    const registry = highlightRegistry();
    const container = containerRef.current;
    if (!registry || !container) return;
    const passage =
      position &&
      readerTextRange(container, position.model, position.passage.start, position.passage.end);
    const word =
      position?.word &&
      readerTextRange(container, position.model, position.word.start, position.word.end);
    if (passage) {
      const painted = new Highlight(passage);
      painted.priority = 1;
      registry.set('reader-narration-passage', painted);
    } else registry.delete('reader-narration-passage');
    if (word) {
      const painted = new Highlight(word);
      painted.priority = 2;
      registry.set('reader-narration-word', painted);
    } else registry.delete('reader-narration-word');
    if (passage && followRef.current && !manualHold.current) {
      const rect = (word ?? passage).getBoundingClientRect();
      const box = container.getBoundingClientRect();
      if (rect.top < box.top + 36 || rect.bottom > box.bottom - 36) {
        container.scrollTop += rect.top - box.top - Math.min(box.height * 0.35, 180);
      }
    }
    return () => {
      registry.delete('reader-narration-passage');
      registry.delete('reader-narration-word');
    };
  }, [position, renderCount, textVersion, follow, containerRef]);

  return {
    status,
    page,
    rate,
    follow,
    timingUnavailable,
    error,
    start,
    pause,
    resume,
    stop,
    setRate,
    setFollow,
  };
}
