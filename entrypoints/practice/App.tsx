import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, LiveStatus } from '../../components/common/ui';
import { Page } from '../../components/common/Page';
import { createPreactRenderer } from '../../components/tooltip/preact-renderer';
import { createToolbar } from '../../components/tooltip/toolbar';
import { t } from '../../lib/i18n';
import {
  createSelectionController,
  type SelectionController,
} from '../../lib/selection/controller';
import type { ToolbarAction } from '../../lib/selection/ui-api';
import { api } from '../../lib/ui-client/api';
import { Article } from './Article';
import { ResultPanel } from './ResultPanel';
import {
  FALLBACK_PREFS,
  runExplain,
  runListen,
  type PracticePrefs,
  type PracticeState,
} from './actions';
import './practice.css';

/**
 * Content scripts do not run on extension pages, so the practice page mounts the same selection
 * observer and toolbar itself. `captureSelection` only accepts http(s)/about: documents, so the
 * article lives in an `about:srcdoc` frame of this page (same origin, so we can reach into it)
 * and the observer and toolbar are created for THAT window and document. No lib/selection or
 * components/tooltip code is modified.
 */
const FRAME_DOC =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>';

export function App() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameDoc, setFrameDoc] = useState<Document | null>(null);
  const [state, setState] = useState<PracticeState>({ kind: 'idle' });
  const [hint, setHint] = useState<string | null>(null);
  const controller = useRef<SelectionController | null>(null);
  const prefs = useRef<PracticePrefs>(FALLBACK_PREFS);
  /** Only the newest action may update the panel; an older, slower reply is dropped. */
  const latest = useRef(0);
  const lastAction = useRef<ToolbarAction | null>(null);

  // The practice page works without any backend answer: defaults apply until preferences arrive.
  useEffect(() => {
    let alive = true;
    void api.getPublicSettings().then((result) => {
      if (alive && result.ok) {
        prefs.current = {
          explanationLanguage: result.data.explanationLanguage,
          ttsRate: result.data.ttsRate,
          ttsLang: result.data.ttsLang,
        };
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const perform = useCallback(async (event: ToolbarAction) => {
    lastAction.current = event;
    const id = ++latest.current;
    const { snapshot } = event;
    setHint(null);
    setState({ kind: 'working', action: event.action, text: snapshot.text });
    const next =
      event.action === 'listen'
        ? await runListen(snapshot, prefs.current)
        : await runExplain(snapshot, prefs.current);
    if (id === latest.current) setState(next);
  }, []);

  const frameReady = frameDoc !== null;
  useEffect(() => {
    const doc = frameDoc;
    const win = doc?.defaultView;
    if (!doc || !win) return;
    const selection = createSelectionController({
      win,
      loadToolbar: (options) =>
        Promise.resolve(createToolbar(createPreactRenderer(), options, doc)),
      onAction: (event) => void perform(event),
    });
    controller.current = selection;
    return () => {
      selection.stop();
      controller.current = null;
    };
  }, [frameDoc, perform]);

  // Size the frame to its article so the page, not the frame, scrolls.
  useEffect(() => {
    const doc = frameDoc;
    const frame = frameRef.current;
    if (!doc || !frame) return;
    const resize = () => {
      // body.offsetHeight, not documentElement.scrollHeight: the latter never shrinks below the frame.
      frame.style.height = `${doc.body.offsetHeight}px`;
    };
    resize();
    window.addEventListener('resize', resize);
    // Text can reflow after fonts load or the zoom level changes.
    const observer = doc.defaultView === null ? null : new doc.defaultView.ResizeObserver(resize);
    observer?.observe(doc.body);
    return () => {
      window.removeEventListener('resize', resize);
      observer?.disconnect();
    };
  }, [frameDoc]);

  async function showToolbar() {
    setHint(null);
    const shown = await controller.current?.openForCurrentSelection({ focus: true });
    if (shown !== true) setHint(t('practiceNoSelection'));
  }

  return (
    <Page title={t('practiceTitle')}>
      <p>{t('practiceIntro')}</p>
      <p className="clavis-muted">{t('practiceNoKey')}</p>
      <h2>{t('practiceTryTitle')}</h2>
      <ul>
        <li>{t('practiceTry1')}</li>
        <li>{t('practiceTry2')}</li>
        <li>{t('practiceTry3')}</li>
      </ul>

      <iframe
        ref={frameRef}
        className="clavis-practice__frame"
        title={t('practiceArticleLabel')}
        srcDoc={FRAME_DOC}
        onLoad={(event) => setFrameDoc(event.currentTarget.contentDocument)}
      />
      {frameReady && frameDoc ? createPortal(<Article />, frameDoc.body) : null}

      <div className="clavis-practice__tools">
        <div className="clavis-actions">
          <Button onClick={() => void showToolbar()}>{t('practiceShowToolbar')}</Button>
        </div>
        <p className="clavis-hint">{t('practiceShowToolbarHint')}</p>
        <LiveStatus message={hint} />
      </div>

      <ResultPanel
        state={state}
        onRetry={() => {
          const again = lastAction.current;
          if (again) void perform(again);
        }}
      />
    </Page>
  );
}
