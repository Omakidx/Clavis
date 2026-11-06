/** @jsxImportSource preact */
import { h, render } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ExplainMode } from '../../lib/contracts/explain';
import type { SidePanelHandoff } from '../../lib/contracts/sidepanel';
import { t } from '../../lib/i18n';
import { isTrustedEvent } from '../../lib/selection/trust';
import { selectionWithin } from '../../lib/selection/contained-range';
import { lookupIcon } from '../tooltip/icons';
import { TranslationSpeech } from './TranslationSpeech';
import type { CardSurface } from '../../lib/selection/ui-api';
import type { SettingsSection } from './backend';
import { truncateText as cutAtCodePoint } from '../../lib/selection/text';
import { resultSelectionFromRange, type ResultLookupInput } from './result-selection';
import { kindLabel, resultBlocks, tabLabel, truncateText, type Block } from './model';
import {
  settingsSectionFor,
  type CardError,
  type Entry,
  type ExplainSession,
  type SessionState,
} from './session';

/**
 * The explanation card view (Preact). Plain text only (D-10, FR-041): every model-written string
 * is a text child, there is no HTML or Markdown rendering, no link is ever made from model output,
 * and no attribute is built from it.
 *
 * Everything the card needs from its surroundings comes through `CardHost`, so the same view runs
 * inside the toolbar's closed shadow root on a web page and inside the practice page's frame.
 */
export interface CardHost {
  /** The action was started from the keyboard, so focus may move into the card. */
  keyboard: boolean;
  /** Placement needs to run again: the card changed size. */
  reposition(): void;
  /** Close the card (and abort its run); the toolbar stays. */
  close(): void;
  openSettings(section?: SettingsSection): Promise<boolean>;
  /**
   * Hand the explanation to the side panel and open it (FR-042). Called synchronously from the
   * click: the user gesture that lets the background open the panel does not survive an `await`.
   */
  openSidePanel(handoff: SidePanelHandoff): Promise<boolean>;
  /** Whether the browser says it is online (only used to word a connection error). */
  online(): boolean;
  /** Copy plain text with the async Clipboard API; false when the page does not allow it. */
  copy(text: string): Promise<boolean>;
  now(): number;
  /** Recursive lookup is supplied only by the toolbar card controller. */
  navigation?: CardNavigation;
  speak?: CardSurface['speak'];
  speakerIcon?: CardSurface['speakerIcon'];
}

export interface CardNavigation {
  canBack: boolean;
  lookup(input: ResultLookupInput): void;
  back(): void;
}

/**
 * A click or key press on the first-send "Explain" is ignored for this long after the prompt
 * appears: a held Enter that started the run auto-repeats onto the freshly focused button, and a
 * page can try to time a click under the pointer. Both are shorter than a person reading the
 * question.
 */
export const CONFIRM_DELAY_MS = 500;

/** How much of the selected text the header keeps in the DOM. */
const HEADER_TEXT_CHARS = 200;

/** An answer longer than this is a long one: the card says the side panel has more room (FR-042). */
export const LONG_ANSWER_CHARS = 700;

interface Props {
  session: ExplainSession;
  host: CardHost;
}

/** Mount the card into `slot`; returns the function that removes it. */
export function mountCard(slot: HTMLElement, props: Props): () => void {
  render(<ExplanationCard key={props.session.selectionId} {...props} />, slot);
  return () => render(null, slot);
}

/** Whether the browser says it is online, following the card's own window's online/offline events. */
function useOnline(host: CardHost, rootRef: { current: HTMLElement | null }): boolean {
  const [online, setOnline] = useState(() => host.online());
  useEffect(() => {
    const win = rootRef.current?.ownerDocument.defaultView;
    if (win === null || win === undefined) return;
    const update = (): void => setOnline(host.online());
    win.addEventListener('online', update);
    win.addEventListener('offline', update);
    return () => {
      win.removeEventListener('online', update);
      win.removeEventListener('offline', update);
    };
  }, [host, rootRef]);
  return online;
}

function useSessionState(session: ExplainSession): SessionState {
  const [state, setState] = useState(session.state);
  useEffect(() => {
    setState(session.state);
    return session.subscribe(setState);
  }, [session]);
  return state;
}

/** Run `handler` for a real user event only (page scripts can only make synthetic ones). */
const onTrusted =
  <E extends Event>(handler: (event: E) => void) =>
  (event: E): void => {
    if (isTrustedEvent(event)) handler(event);
  };

function ExplanationCard({ session, host }: Props) {
  const state = useSessionState(session);
  const uid = useId();
  const rootRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<ExplainMode, HTMLButtonElement>());
  const [focusTab, setFocusTab] = useState<ExplainMode>(state.active);
  const [armed, setArmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lookupCandidate, setLookupCandidate] = useState<{
    input: ResultLookupInput;
    selectionId: string;
    mode: ExplainMode;
    result: Entry['result'];
  } | null>(null);
  const [lookupFeedback, setLookupFeedback] = useState('');
  const online = useOnline(host, rootRef);

  const entries = state.entries;
  const core = entries.core;

  // Keyboard users land on the card; mouse users keep the page's focus and selection (the toolbar
  // does the same: pressing its buttons never moves focus).
  useEffect(() => {
    if (host.keyboard) rootRef.current?.focus({ preventScroll: true });
  }, [host]);

  // A decision is needed: put keyboard focus on the confirmation.
  const needsConfirm = core?.status === 'disclosure';
  useEffect(() => {
    if (needsConfirm && host.keyboard) confirmRef.current?.focus({ preventScroll: true });
  }, [needsConfirm, host]);

  // Live regions announce CHANGES, not content that was there at insertion: arm it a beat after mount.
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), 80);
    return () => clearTimeout(timer);
  }, []);

  // The card changed size (a result arrived, a tab opened): placement runs again.
  useLayoutEffect(() => {
    host.reposition();
  }, [state, copied, host]);
  useEffect(() => {
    const element = rootRef.current;
    const Observer = element?.ownerDocument.defaultView?.ResizeObserver;
    if (element === null || Observer === undefined) return;
    const observer = new Observer(() => host.reposition());
    observer.observe(element);
    return () => observer.disconnect();
  }, [host]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // The tab that has focus in the tab list follows the selected tab.
  useEffect(() => setFocusTab(state.active), [state.active]);

  const selected = truncateText(state.text);
  // The same cut as the toolbar's own state line (CARD_TEXT_MAX_CHARS); CSS clamps it to two lines.
  const shown = cutAtCodePoint(state.text, HEADER_TEXT_CHARS);
  const tabs = state.tabs;
  const active = entries[state.active];

  // A candidate belongs to one result in one tab of one frame. A late answer, tab switch, or
  // replacement frame cannot keep an earlier selection actionable.
  useEffect(() => {
    if (
      lookupCandidate !== null &&
      (lookupCandidate.selectionId !== state.selectionId ||
        lookupCandidate.mode !== state.active ||
        lookupCandidate.result !== active?.result)
    )
      setLookupCandidate(null);
  }, [active?.result, lookupCandidate, state.active, state.selectionId]);

  const captureResultSelection = (): void => {
    const root = rootRef.current;
    const panel = root?.querySelector<HTMLElement>(
      `[data-clavis="card-panel"][data-tab="${state.active}"]`,
    );
    const range = root === null || panel == null ? null : selectionWithin(root);
    const candidate =
      range === null || panel == null ? null : resultSelectionFromRange(range, panel);
    if (candidate?.kind === 'over-limit') {
      setLookupCandidate(null);
      setLookupFeedback(t('cardLookupOverLimit'));
    } else {
      setLookupFeedback('');
      setLookupCandidate(
        candidate?.kind === 'ready' && active?.status === 'ready'
          ? {
              input: candidate.input,
              selectionId: state.selectionId,
              mode: state.active,
              result: active.result,
            }
          : null,
      );
    }
  };

  const clearIfOutsideResult = (event: MouseEvent | KeyboardEvent): void => {
    if (!isTrustedEvent(event)) return;
    const target = event.target;
    const root = rootRef.current;
    if (root === null || target === null || typeof (target as Node).nodeType !== 'number') return;
    const panel = root.querySelector<HTMLElement>(
      `[data-clavis="card-panel"][data-tab="${state.active}"]`,
    );
    const lookup = root.querySelector<HTMLElement>('[data-clavis="card-lookup"]');
    if (panel?.contains(target as Node) || lookup?.contains(target as Node)) return;
    setLookupCandidate(null);
    setLookupFeedback('');
  };

  useEffect(() => {
    const doc = rootRef.current?.ownerDocument;
    if (doc === undefined) return;
    const clearOutside = (event: MouseEvent | KeyboardEvent): void => {
      if (!isTrustedEvent(event)) return;
      const target = event.target;
      const root = rootRef.current;
      const shadowHost = (root?.getRootNode() as ShadowRoot | undefined)?.host;
      if (
        root === null ||
        target === null ||
        typeof (target as Node).nodeType !== 'number' ||
        (!root.contains(target as Node) && target !== shadowHost)
      ) {
        setLookupCandidate(null);
        setLookupFeedback('');
      }
    };
    doc.addEventListener('mouseup', clearOutside);
    doc.addEventListener('keyup', clearOutside);
    return () => {
      doc.removeEventListener('mouseup', clearOutside);
      doc.removeEventListener('keyup', clearOutside);
    };
  }, []);

  const moveFocus = (mode: ExplainMode): void => {
    setFocusTab(mode);
    tabRefs.current.get(mode)?.focus();
  };

  // WAI-ARIA tabs, manual activation: arrows only move focus, Enter or Space opens the tab. Opening
  // a tab for the first time costs a Groq request, so merely arrowing past one must not.
  const onTabKeyDown = (event: KeyboardEvent): void => {
    if (!isTrustedEvent(event)) return;
    const index = tabs.indexOf(focusTab);
    const rtl =
      rootRef.current?.ownerDocument.defaultView?.getComputedStyle(rootRef.current).direction ===
      'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: number;
    if (event.key === forward) next = (index + 1) % tabs.length;
    else if (event.key === backward) next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    // The toolbar around the card has its own arrow-key group: this is not for it.
    event.stopPropagation();
    const mode = tabs[next];
    if (mode !== undefined) moveFocus(mode);
  };

  const openSettings = (section: SettingsSection | undefined): void => {
    void host.openSettings(section).then((opened) => {
      if (!opened) session.announce(t('cardSettingsFailed'));
    });
  };

  const copyActive = (): void => {
    const text = session.activeText();
    if (text === null) return;
    void host.copy(text).then((ok) => {
      setCopied(ok);
      session.announce(ok ? t('cardCopied') : t('cardCopyFailed'));
    });
  };

  // The click that asks for the panel must reach the background in the same task (see CardHost).
  const openPanel = (): void => {
    const handoff = session.handoff();
    if (handoff === null) return;
    void host.openSidePanel(handoff).then((opened) => {
      session.announce(opened ? t('cardPanelOpened') : t('cardPanelFailed'));
    });
  };

  const model = active?.status === 'ready' ? active.result?.model : undefined;
  const longAnswer = (session.activeText()?.length ?? 0) > LONG_ANSWER_CHARS;

  return (
    <section
      ref={rootRef}
      class="ec"
      data-clavis="card"
      data-action="explain"
      tabIndex={-1}
      aria-label={t('cardRegion', selected)}
      onMouseUp={clearIfOutsideResult}
      onKeyUp={clearIfOutsideResult}
    >
      <header class="ec__head">
        {host.navigation?.canBack === true ? (
          <button
            type="button"
            class="ec__btn ec__back"
            data-clavis="card-back"
            aria-label={t('cardBack')}
            onClick={onTrusted(() => host.navigation?.back())}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="m8 3-3 3 3 3" stroke="currentColor" stroke-width="1.5" />
            </svg>
            {t('cardBack')}
          </button>
        ) : null}
        <div class="ec__who">
          <p class="ec__kind">{kindLabel(state.kind)}</p>
          <p class="ec__selected" dir="auto" data-clavis="card-text">
            {shown}
          </p>
        </div>
        <button
          type="button"
          class="ec__btn"
          data-clavis="card-close"
          onClick={onTrusted(host.close)}
        >
          {t('toolbarClose')}
        </button>
      </header>

      {tabs.length > 1 ? (
        <div class="ec__tabs" role="tablist" aria-label={t('cardTabsLabel')}>
          {tabs.map((mode) => {
            const entry = entries[mode];
            const selectedTab = mode === state.active;
            return (
              <button
                key={mode}
                ref={(element) => {
                  if (element === null) tabRefs.current.delete(mode);
                  else tabRefs.current.set(mode, element);
                }}
                type="button"
                role="tab"
                class="ec__tab"
                id={`${uid}-tab-${mode}`}
                data-clavis="card-tab"
                data-tab={mode}
                data-status={entry?.status ?? 'idle'}
                aria-selected={selectedTab ? 'true' : 'false'}
                aria-controls={`${uid}-panel-${mode}`}
                tabIndex={mode === focusTab ? 0 : -1}
                onKeyDown={onTabKeyDown}
                onClick={onTrusted(() => {
                  setLookupCandidate(null);
                  setLookupFeedback('');
                  setFocusTab(mode);
                  session.selectTab(mode);
                })}
              >
                {tabLabel(mode)}
              </button>
            );
          })}
        </div>
      ) : null}

      {tabs.map((mode) => (
        <div
          key={mode}
          role="tabpanel"
          class="ec__body"
          id={`${uid}-panel-${mode}`}
          aria-labelledby={`${uid}-tab-${mode}`}
          data-clavis="card-panel"
          data-tab={mode}
          data-status={entries[mode]?.status ?? 'idle'}
          tabIndex={0}
          hidden={mode !== state.active}
          onMouseUp={onTrusted(captureResultSelection)}
          onKeyUp={onTrusted(captureResultSelection)}
        >
          <PanelContent
            mode={mode}
            isActive={mode === state.active}
            entry={entries[mode]}
            session={session}
            host={host}
            confirmRef={confirmRef}
            online={online}
            onSettings={openSettings}
          />
        </div>
      ))}

      {lookupCandidate !== null &&
      lookupCandidate.selectionId === state.selectionId &&
      lookupCandidate.mode === state.active &&
      lookupCandidate.result === active?.result &&
      host.navigation !== undefined ? (
        <div class="ec__lookup-action">
          <button
            type="button"
            class="ec__btn ec__btn--primary ec__lookup-btn"
            data-clavis="card-lookup"
            onMouseDown={onTrusted((event: MouseEvent) => event.preventDefault())}
            onClick={onTrusted(() => {
              const root = rootRef.current;
              const panel = root?.querySelector<HTMLElement>(
                `[data-clavis="card-panel"][data-tab="${state.active}"]`,
              );
              const range = root === null || panel == null ? null : selectionWithin(root);
              const actual =
                range === null || panel == null ? null : resultSelectionFromRange(range, panel);
              const unchanged =
                actual?.kind === 'ready' &&
                actual.input.text === lookupCandidate.input.text &&
                actual.input.contextBefore === lookupCandidate.input.contextBefore &&
                actual.input.contextAfter === lookupCandidate.input.contextAfter;
              if (!unchanged) {
                setLookupCandidate(null);
                return;
              }
              host.navigation?.lookup(lookupCandidate.input);
              setLookupCandidate(null);
            })}
          >
            {lookupIcon((tag, props, ...children) => h(tag, props, ...children))}
            <span>{t('cardLookup')}</span>
            <span class="ec__lookup-word" dir="auto">
              {cutAtCodePoint(lookupCandidate.input.text, 32)}
            </span>
          </button>
        </div>
      ) : null}
      {lookupFeedback !== '' ? (
        <p class="ec__lookup-feedback" role="status">
          {lookupFeedback}
        </p>
      ) : null}

      {longAnswer ? (
        <p class="ec__hint" data-clavis="card-long-hint">
          {t('cardLongHint')}
        </p>
      ) : null}

      <footer class="ec__foot">
        <div class="ec__actions">
          <button
            type="button"
            class="ec__btn"
            data-clavis="card-copy"
            aria-disabled={active?.status === 'ready' ? undefined : 'true'}
            onClick={onTrusted(() => {
              if (active?.status === 'ready') copyActive();
            })}
          >
            {copied ? t('cardCopied') : t('cardCopy')}
          </button>
          <button
            type="button"
            class={longAnswer ? 'ec__btn ec__btn--suggest' : 'ec__btn'}
            data-clavis="card-side-panel"
            aria-disabled={core?.status === 'ready' ? undefined : 'true'}
            onClick={onTrusted(() => {
              if (core?.status === 'ready') openPanel();
            })}
          >
            {t('cardOpenPanel')}
          </button>
        </div>
        {model === undefined ? null : (
          <p class="ec__model" dir="auto" data-clavis="card-model">
            {t('cardModel', model)}
          </p>
        )}
      </footer>

      <div class="ec__sr" role="status" data-clavis="card-live">
        {armed ? state.live : ''}
      </div>
    </section>
  );
}

interface PanelProps {
  mode: ExplainMode;
  /** The tab is the one on screen; a tab nobody opened has nothing to show yet. */
  isActive: boolean;
  entry: Entry | undefined;
  session: ExplainSession;
  host: CardHost;
  confirmRef: { current: HTMLButtonElement | null };
  online: boolean;
  onSettings(section: SettingsSection | undefined): void;
}

function PanelContent({
  mode,
  isActive,
  entry,
  session,
  host,
  confirmRef,
  online,
  onSettings,
}: PanelProps) {
  if (entry === undefined && !isActive) return null;
  if (entry === undefined || entry.status === 'queued' || entry.status === 'loading') {
    return (
      <p class="ec__loading" data-clavis="card-loading">
        <span class="ec__spinner" aria-hidden="true" />
        {mode === 'core' ? t('cardLoading') : t('cardLoadingTab', tabLabel(mode))}
      </p>
    );
  }
  if (entry.status === 'disclosure') {
    return <DisclosurePrompt mode={mode} session={session} host={host} confirmRef={confirmRef} />;
  }
  if (entry.status === 'error' && entry.error !== null) {
    return (
      <ErrorView
        error={entry.error}
        mode={mode}
        session={session}
        host={host}
        online={online}
        onSettings={onSettings}
      />
    );
  }
  return entry.result === null ? null : (
    <ResultView
      blocks={resultBlocks(entry.result)}
      speech={
        mode === 'translate' && isActive ? { host, lang: session.translationLanguage } : undefined
      }
    />
  );
}

function DisclosurePrompt({
  mode,
  session,
  host,
  confirmRef,
}: {
  mode: ExplainMode;
  session: ExplainSession;
  host: CardHost;
  confirmRef: { current: HTMLButtonElement | null };
}) {
  // The moment this prompt first rendered; the component exists exactly while the prompt shows.
  const [shownAt] = useState(() => host.now());
  return (
    <div class="ec__confirm" data-clavis="card-disclosure">
      <p>{t('firstSendBody')}</p>
      <div class="ec__actions">
        <button
          ref={confirmRef}
          type="button"
          class="ec__btn ec__btn--primary"
          data-clavis="card-confirm"
          onClick={onTrusted(() => {
            if (host.now() - shownAt >= CONFIRM_DELAY_MS) session.confirmDisclosure(mode);
          })}
        >
          {t('firstSendConfirm')}
        </button>
        <button
          type="button"
          class="ec__btn"
          data-clavis="card-cancel"
          onClick={onTrusted(host.close)}
        >
          {t('firstSendCancel')}
        </button>
      </div>
    </div>
  );
}

function ResultView({
  blocks,
  speech,
}: {
  blocks: Block[];
  speech?: { host: CardHost; lang: string | undefined } | undefined;
}) {
  return (
    <div class="ec__result" data-clavis="card-result">
      {/* Each piece of model text decides its own direction (dir="auto"), so an Arabic answer next to
          an English label, or an English example inside a Hebrew answer, each read the right way. */}
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'title':
            return (
              <p key={index} class="ec__title" dir="auto" data-clavis="card-result-text">
                {block.text}
              </p>
            );
          case 'paragraph':
            return (
              <p key={index} dir="auto" data-clavis="card-result-text">
                {block.text}
              </p>
            );
          case 'field':
          case 'note': {
            const content = (
              <p dir="auto" data-clavis={block.lookup === false ? undefined : 'card-result-text'}>
                {block.text}
              </p>
            );
            return (
              <div
                key={index}
                class={block.kind === 'note' ? 'ec__field ec__field--note' : 'ec__field'}
              >
                <p class="ec__label">{block.label}</p>
                {block.kind === 'field' &&
                block.speak === true &&
                speech?.host.speak !== undefined ? (
                  <div class="ec__translation-line">
                    {content}
                    <TranslationSpeech text={block.text} lang={speech.lang} host={speech.host} />
                  </div>
                ) : (
                  content
                )}
              </div>
            );
          }
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <div key={index} class="ec__field">
                <p class="ec__label">{block.label}</p>
                <List class="ec__list" dir="auto">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex} dir="auto" data-clavis="card-result-text">
                      {item}
                    </li>
                  ))}
                </List>
              </div>
            );
          }
        }
      })}
    </div>
  );
}

interface ErrorProps {
  error: CardError;
  mode: ExplainMode;
  session: ExplainSession;
  host: CardHost;
  online: boolean;
  onSettings(section: SettingsSection | undefined): void;
}

/** Errors that mean "could not reach Groq": worded differently when the browser knows it is offline. */
const CONNECTION_CODES: readonly string[] = ['NETWORK_ERROR', 'TIMEOUT', 'NO_RESPONSE'];

function ErrorView({ error, mode, session, host, online, onSettings }: ErrorProps) {
  const offline =
    !online && error.httpStatus === undefined && CONNECTION_CODES.includes(error.code);
  return (
    <div
      class={error.quiet === true ? 'ec__error ec__error--quiet' : 'ec__error'}
      data-clavis="card-error"
      data-code={error.code}
      data-offline={offline ? 'true' : undefined}
    >
      {offline ? (
        <p class="ec__error-title">{t('cardErrOfflineTitle')}</p>
      ) : error.title === null ? null : (
        <p class="ec__error-title">{error.title}</p>
      )}
      <p>{offline ? t('errOffline') : error.message}</p>
      <div class="ec__actions">
        {error.action === 'retry' ? (
          <RetryButton error={error} mode={mode} session={session} host={host} />
        ) : error.action === 'none' ? null : (
          <button
            type="button"
            class="ec__btn ec__btn--primary"
            data-clavis="card-settings"
            onClick={onTrusted(() => onSettings(settingsSectionFor(error.action)))}
          >
            {error.action === 'connect'
              ? t('cardActionConnect')
              : error.action === 'update-key'
                ? t('cardActionUpdateKey')
                : error.action === 'choose-model'
                  ? t('cardActionChooseModel')
                  : t('uiOpenSettings')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * "Try again": never automatic. While a rate-limit delay runs it stays visible but inactive
 * (aria-disabled, so keyboard users can still find it) and counts down; when the delay ends the
 * live region says so.
 */
function RetryButton({
  error,
  mode,
  session,
  host,
}: {
  error: CardError;
  mode: ExplainMode;
  session: ExplainSession;
  host: CardHost;
}) {
  const remaining = (): number =>
    error.retryAt === undefined ? 0 : Math.max(0, Math.ceil((error.retryAt - host.now()) / 1000));
  const [seconds, setSeconds] = useState(remaining);
  useEffect(() => {
    setSeconds(remaining());
    if (remaining() === 0) return;
    const timer = setInterval(() => {
      const left = remaining();
      setSeconds(left);
      if (left === 0) {
        clearInterval(timer);
        session.announce(t('cardRetryReady'));
      }
    }, 1000);
    return () => clearInterval(timer);
    // `remaining` only reads `error` and the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);
  const waiting = seconds > 0;
  return (
    <button
      type="button"
      class="ec__btn ec__btn--primary"
      data-clavis="card-retry"
      aria-disabled={waiting ? 'true' : undefined}
      onClick={onTrusted(() => {
        if (!waiting) session.retry(mode);
      })}
    >
      {waiting
        ? t('cardRetryWait', String(seconds))
        : error.quiet === true
          ? t('cardLoadAgain')
          : t('uiRetry')}
    </button>
  );
}
