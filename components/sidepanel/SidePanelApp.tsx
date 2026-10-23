import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { SidePanelHandoff } from '../../lib/contracts';
import { t } from '../../lib/i18n';
import { createListenController, type ListenController } from '../../lib/selection/listen';
import { Page } from '../common/Page';
import { Button, LiveStatus } from '../common/ui';
import { createBackend, type ExplainBackend } from '../explanation/backend';
import { copyPlainText } from '../explanation/copy';
import { kindLabel, tabLabel, truncateText } from '../explanation/model';
import { ListenBar, listenMessage } from './ListenBar';
import { SectionView } from './SectionView';
import { createPanelClient, isFromBackground, tabFromSearch, type PanelClient } from './client';
import { allText, sectionText } from './text';
import { useListen } from './useListen';
import { usePanelSession } from './usePanelSession';
import './sidepanel.css';

/** Everything the panel needs from outside, so tests can stand in for Chrome. */
export interface PanelDeps {
  tabId: number | undefined;
  client: PanelClient;
  backend: ExplainBackend;
  speech: ListenController;
  newId(): string;
  now(): number;
  copy(text: string): Promise<boolean>;
  /** Whether the browser says it is online (only used to word a connection error). */
  online(): boolean;
}

export function createPanelDeps(): PanelDeps {
  return {
    tabId: tabFromSearch(window.location.search),
    client: createPanelClient(),
    backend: createBackend(),
    speech: createListenController(),
    newId: () => crypto.randomUUID(),
    now: Date.now,
    copy: (text) => copyPlainText(document, text),
    online: () => navigator.onLine,
  };
}

type View =
  | { phase: 'loading' }
  /** Nothing is held for this tab: say how to fill the panel, and why a previous one may be gone. */
  | { phase: 'empty' }
  | { phase: 'ready'; handoff: SidePanelHandoff; revision: number };

/** Follows the hand-off of this panel's tab: once on open, then whenever the worker says it changed. */
function useHandoff(deps: PanelDeps): View {
  const [view, setView] = useState<View>({ phase: 'loading' });
  const { tabId, client } = deps;
  useEffect(() => {
    if (tabId === undefined) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const state = await client.fetchState(tabId);
      if (cancelled) return;
      setView(
        state.handoff === null
          ? { phase: 'empty' }
          : { phase: 'ready', handoff: state.handoff, revision: state.revision },
      );
    };
    void load();
    const off = client.onUpdated(tabId, () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [tabId, client]);
  // Opened by hand, not for a tab: there is nothing it could ever show.
  return tabId === undefined ? { phase: 'empty' } : view;
}

/** Whether the browser says it is online, following the window's online/offline events. */
function useOnline(deps: PanelDeps): boolean {
  const [online, setOnline] = useState(() => deps.online());
  useEffect(() => {
    const update = (): void => setOnline(deps.online());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [deps]);
  return online;
}

export function SidePanelApp({ deps: given }: { deps?: PanelDeps }) {
  const deps = useMemo(() => given ?? createPanelDeps(), [given]);
  const view = useHandoff(deps);
  const handoff = view.phase === 'ready' ? view.handoff : null;
  const { session, state } = usePanelSession(handoff, deps.backend, deps.newId, deps.now);
  const listen = useListen(deps.speech, handoff?.snapshot ?? null);
  const online = useOnline(deps);
  const [note, setNote] = useState('');

  // TTS_EVENT (the end of an utterance) comes from the service worker as a runtime message.
  useEffect(() => {
    const onMessage = (message: unknown, sender: Parameters<typeof isFromBackground>[0]) => {
      if (isFromBackground(sender)) deps.speech.handleEvent(message);
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [deps]);

  // A different selection arrived while the panel was open: say so (no focus is stolen).
  const shownSelection = useRef<string | null>(null);
  const selectionId = handoff?.snapshot.selectionId ?? null;
  const selectedText = handoff?.snapshot.text ?? '';
  useEffect(() => {
    if (selectionId === null) {
      shownSelection.current = null;
      return;
    }
    if (shownSelection.current !== null && shownSelection.current !== selectionId) {
      setNote(t('panelUpdated', truncateText(selectedText)));
    }
    shownSelection.current = selectionId;
  }, [selectionId, selectedText]);

  const copy = useCallback(
    (text: string | null): void => {
      if (text === null) return;
      void deps.copy(text).then((ok) => setNote(ok ? t('cardCopied') : t('cardCopyFailed')));
    },
    [deps],
  );

  const openSettings = useCallback(
    (section: Parameters<ExplainBackend['openSettings']>[0]): void => {
      void deps.backend.openSettings(section).then((opened) => {
        if (!opened) setNote(t('cardSettingsFailed'));
      });
    },
    [deps],
  );

  const jumpTo = (mode: string) => (event: { preventDefault(): void }) => {
    event.preventDefault();
    const heading = document.getElementById(`sp-heading-${mode}`);
    if (heading === null) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    heading.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    heading.focus({ preventScroll: true });
  };

  return (
    <Page title={t('panelTitle')}>
      {view.phase === 'loading' ? (
        <p className="clavis-muted" data-testid="panel-loading-state">
          {t('uiLoading')}
        </p>
      ) : null}

      {view.phase === 'empty' ? (
        <section className="sp-empty" data-testid="panel-empty" aria-labelledby="sp-empty-title">
          <h2 id="sp-empty-title">{t('panelEmptyTitle')}</h2>
          <p>{t('panelEmptyBody')}</p>
        </section>
      ) : null}

      {handoff !== null && session !== null && state !== null ? (
        <>
          <header className="sp-head">
            <p className="sp-kind">
              {kindLabel(handoff.snapshot.kind)}
              {handoff.snapshot.page === undefined
                ? ''
                : ` · ${t('panelPdfPage', String(handoff.snapshot.page))}`}
            </p>
            <h2 className="sp-label" id="sp-selected-label">
              {t('panelSelectedLabel')}
            </h2>
            {/* The whole selection (at most 2,000 characters), as text, in its own direction. */}
            <p
              className="sp-selected"
              dir="auto"
              tabIndex={0}
              aria-labelledby="sp-selected-label"
              data-testid="panel-selected"
            >
              {handoff.snapshot.text}
            </p>
            <ListenBar
              report={listen.report}
              slowChoice={listen.slowChoice}
              onStart={listen.start}
              onStop={listen.stop}
              onToggleSlow={listen.toggleSlow}
              onVoiceSettings={deps.speech.openVoiceSettings}
            />
            <div className="clavis-actions">
              <Button
                data-testid="panel-copy-all"
                onClick={() => copy(allText(handoff.snapshot.text, state.tabs, state.entries))}
              >
                {t('panelCopyAll')}
              </Button>
            </div>
            <p className="clavis-hint">{t('panelAiNote')}</p>
          </header>

          <nav aria-label={t('panelSectionsLabel')}>
            <ul className="sp-nav">
              {state.tabs.map((mode) => (
                <li key={mode}>
                  <a
                    href={`#sp-section-${mode}`}
                    data-testid="panel-nav"
                    data-mode={mode}
                    onClick={jumpTo(mode)}
                  >
                    {tabLabel(mode)}
                    {state.entries[mode]?.status === 'ready' ? null : (
                      <span className="clavis-sr-only"> ({t('panelNotLoadedShort')})</span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="sp-sections">
            {state.tabs.map((mode) => (
              <SectionView
                key={mode}
                mode={mode}
                entry={state.entries[mode]}
                session={session}
                now={deps.now}
                online={online}
                onCopy={(target) => copy(sectionText(target, state.entries[target]))}
                onSettings={openSettings}
              />
            ))}
          </div>

          <footer className="sp-foot">
            {firstModel(state) === undefined ? null : (
              <p className="clavis-hint" dir="auto" data-testid="panel-model">
                {t('cardModel', firstModel(state) ?? '')}
              </p>
            )}
          </footer>
        </>
      ) : null}

      {/* Both regions exist before they have anything to say, so changes are announced. */}
      <LiveStatus message={state?.live ?? ''} />
      <LiveStatus message={note || listenMessage(listen.report)} />
    </Page>
  );
}

/** The model that wrote the core answer (or the first loaded part). */
function firstModel(
  state: NonNullable<ReturnType<typeof usePanelSession>['state']>,
): string | undefined {
  for (const mode of state.tabs) {
    const entry = state.entries[mode];
    if (entry?.status === 'ready' && entry.result !== null) return entry.result.model;
  }
  return undefined;
}
