import { h, render, type VNode } from 'preact';
import type { SelectionKind } from '../../../lib/contracts/selection';
import { t } from '../../../lib/i18n';
import { mountCard, type CardHost } from '../../../components/explanation/ExplanationCard';
import type { BackendReply, ExplainBackend } from '../../../components/explanation/backend';
import { ExplainSession } from '../../../components/explanation/session';
import {
  toolbarView,
  type CreateElement,
  type ListenViewState,
  type ToolbarViewProps,
} from '../../../components/tooltip/view';
import toolbarCss from '../../../components/tooltip/toolbar.css?inline';
import cardCss from '../../../components/explanation/card.css?inline';
import { registerRoot } from '../scheme';
import {
  SAMPLE_PASSAGE,
  SAMPLE_SENTENCE,
  SAMPLE_WORD,
  SAMPLE_IDS,
  fakeLongResult,
  fakeResult,
} from '../fixtures';

/**
 * The "Web page" screen: the REAL toolbar view and explanation card (same components, same
 * toolbar.css / card.css) drawn statically in open shadow roots, one specimen per state, next to a
 * sample article. In a real page these live in a closed shadow root and are placed by
 * components/tooltip/toolbar.ts; here they only need the styles to apply. Everything is wired to
 * fake backends, so tabs, Retry, Confirm and Copy respond.
 *
 * This module is its own hot-update boundary: editing a component or stylesheet it imports
 * re-runs it (dispose below) instead of reloading the frame.
 */

const create = h as unknown as CreateElement<VNode>;
const page = document.getElementById('root');
const cleanups: Array<() => void> = [];

// ---------------------------------------------------------------------------------------------
// Specimen chrome
// ---------------------------------------------------------------------------------------------

const PAGE_CSS = `
:root {
  color-scheme: light;
  --pv-bg: #f6f7eb; --pv-fg: #252820; --pv-muted: #5d6255; --pv-line: #dce0cf;
  --pv-mark: #ffebc4;
}
:root[data-preview-theme='dark'] {
  color-scheme: dark;
  --pv-bg: #20221b; --pv-fg: #f6f7eb; --pv-muted: #b9beac; --pv-line: #414536;
  --pv-mark: #493a20;
}
html { background: var(--pv-bg); }
body { margin: 0; font: 16px/1.6 Georgia, 'Times New Roman', serif; color: var(--pv-fg); background: var(--pv-bg); }
.pv-wrap { max-width: 1280px; margin: 0 auto; padding: 24px 16px 64px; }
.pv-head { font: 600 13px/1.4 system-ui, sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--pv-muted); margin: 40px 0 12px; }
.pv-article { max-width: 42rem; }
.pv-article h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 .5rem; }
.pv-article .pv-meta { font: 14px system-ui, sans-serif; color: var(--pv-muted); margin: 0 0 1.5rem; }
.pv-article mark { background: var(--pv-mark); color: inherit; padding: 0 2px; border-radius: 2px; }
.pv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); gap: 16px; align-items: start; }
.pv-spec { border-top: 1px solid var(--pv-line); padding: 12px 0; font-family: system-ui, sans-serif; }
.pv-spec > h3 { font: 600 13px/1.3 system-ui, sans-serif; margin: 0 0 2px; }
.pv-spec > p { font: 12px/1.4 system-ui, sans-serif; color: var(--pv-muted); margin: 0 0 10px; }
.pv-spec > .pv-stage { min-height: 40px; }
`;

// The real toolbar positions itself `fixed`; in a specimen it just sits in the flow.
const SPECIMEN_OVERRIDE = `.panel { position: relative !important; } .card-slot { max-height: 30rem; }`;

function sheet(css: string): CSSStyleSheet {
  const result = new CSSStyleSheet();
  result.replaceSync(css);
  return result;
}

/** One labelled specimen with an open shadow root that has the real stylesheets. */
function specimen(parent: HTMLElement, title: string, note: string): HTMLElement {
  const box = document.createElement('section');
  box.className = 'pv-spec';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const description = document.createElement('p');
  description.textContent = note;
  const stage = document.createElement('div');
  stage.className = 'pv-stage';
  box.append(heading, description, stage);
  parent.append(box);
  const root = stage.attachShadow({ mode: 'open' });
  root.adoptedStyleSheets = [sheet(toolbarCss), sheet(cardCss), sheet(SPECIMEN_OVERRIDE)];
  const container = document.createElement('div');
  root.append(container);
  registerRoot(root);
  return container;
}

// ---------------------------------------------------------------------------------------------
// Toolbar specimens
// ---------------------------------------------------------------------------------------------

const IDLE: ListenViewState = { status: 'idle', slow: false, message: '', hint: '', note: '' };

function toolbarProps(
  over: Partial<ToolbarViewProps> = {},
  kind: SelectionKind = 'word',
): ToolbarViewProps {
  return {
    mode: 'actions',
    kind,
    notice: '',
    card: null,
    trimmed: null,
    busy: null,
    listen: IDLE,
    live: '',
    onAction: () => undefined,
    ...over,
  };
}

/** A toolbar whose Slow toggle and Listen button respond, so states can be felt as well as seen. */
function mountToolbar(container: HTMLElement, initial: ToolbarViewProps): void {
  let props = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const draw = () => render(toolbarView({ ...props, onAction }, create), container);
  const set = (listen: Partial<ListenViewState>) => {
    props = { ...props, listen: { ...props.listen, ...listen } };
    draw();
  };
  const onAction: ToolbarViewProps['onAction'] = (action) => {
    if (action === 'slow') set({ slow: !props.listen.slow });
    if (action === 'listen' && props.mode === 'actions' && props.listen.status !== 'unavailable') {
      clearTimeout(timer);
      if (props.listen.status === 'starting' || props.listen.status === 'playing') {
        set({ status: 'idle', note: '' });
        return;
      }
      set({ status: 'starting' });
      timer = setTimeout(() => {
        set({ status: 'playing' });
        timer = setTimeout(() => set({ status: 'ended' }), 2500);
      }, 700);
    }
  };
  draw();
  cleanups.push(() => {
    clearTimeout(timer);
    render(null, container);
  });
}

// ---------------------------------------------------------------------------------------------
// Card specimens
// ---------------------------------------------------------------------------------------------

type Behavior = 'answer' | 'loading' | BackendReply;

function backendFor(behavior: Behavior): ExplainBackend {
  return {
    explain: (request) => {
      if (behavior === 'loading') return new Promise<BackendReply>(() => undefined);
      if (behavior === 'answer') {
        const result =
          request.mode === 'simplify' && request.snapshot.kind === 'passage'
            ? fakeLongResult(request.requestId)
            : fakeResult(request);
        return new Promise<BackendReply>((resolve) =>
          setTimeout(() => resolve({ kind: 'result', result }), 350),
        );
      }
      return Promise.resolve(behavior);
    },
    cancel: () => undefined,
    openSettings: () => Promise.resolve(true),
    openSidePanel: () => Promise.resolve(true),
    translationLanguage: () => Promise.resolve('es'),
  };
}

const host: CardHost = {
  keyboard: false,
  reposition: () => undefined,
  close: () => undefined,
  openSettings: () => Promise.resolve(true),
  openSidePanel: () => Promise.resolve(true),
  online: () => navigator.onLine,
  copy: () => Promise.resolve(true),
  now: Date.now,
};

let cardCount = 0;

function mountCardSpecimen(
  container: HTMLElement,
  behavior: Behavior,
  text: string,
  kind: SelectionKind,
  after?: (session: ExplainSession) => void,
): void {
  cardCount += 1;
  const session = new ExplainSession({
    snapshot: { selectionId: SAMPLE_IDS.request(900 + cardCount), source: 'webpage', kind, text },
    backend: backendFor(behavior),
    newId: () => crypto.randomUUID(),
    targetLanguage: 'es',
  });
  const props = toolbarProps({ card: { action: 'explain', text, note: '', slot: true } }, kind);
  render(toolbarView(props, create), container);
  const slot = container.querySelector<HTMLElement>('[data-clavis="card-slot"]');
  if (slot === null) return;
  const unmount = mountCard(slot, { session, host });
  session.attach();
  after?.(session);
  cleanups.push(() => {
    unmount();
    session.destroy();
    render(null, container);
  });
}

// ---------------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------------

function build(): void {
  if (page === null) return;
  const style = document.createElement('style');
  style.textContent = PAGE_CSS;
  const wrap = document.createElement('div');
  wrap.className = 'pv-wrap';
  page.append(style, wrap);
  cleanups.push(() => {
    style.remove();
    wrap.remove();
  });

  const article = document.createElement('article');
  article.className = 'pv-article';
  const title = document.createElement('h1');
  title.textContent = 'Why cherry blossoms matter in Japan';
  const meta = document.createElement('p');
  meta.className = 'pv-meta';
  meta.textContent = 'A sample web page, with a selection the toolbar would attach to.';
  const p1 = document.createElement('p');
  const lead = document.createTextNode('The ');
  const mark = document.createElement('mark');
  mark.textContent = SAMPLE_WORD;
  p1.append(
    lead,
    mark,
    document.createTextNode(SAMPLE_SENTENCE.slice(SAMPLE_SENTENCE.indexOf(' beauty'))),
  );
  const p2 = document.createElement('p');
  p2.textContent = SAMPLE_PASSAGE;
  article.append(title, meta, p1, p2);
  wrap.append(article);

  const section = (name: string): HTMLElement => {
    const heading = document.createElement('h2');
    heading.className = 'pv-head';
    heading.textContent = name;
    const grid = document.createElement('div');
    grid.className = 'pv-grid';
    wrap.append(heading, grid);
    return grid;
  };

  // ---- Toolbar ----
  const bar = section('Selection toolbar (components/tooltip: view.ts + toolbar.css)');
  mountToolbar(
    specimen(bar, 'Idle', 'Lookup, Speak and 0.75× speed. Try Speak and the speed toggle.'),
    toolbarProps(),
  );
  mountToolbar(
    specimen(bar, 'Listening starts', 'Spinner while the voice starts (aria-busy).'),
    toolbarProps({ listen: { ...IDLE, status: 'starting' } }),
  );
  mountToolbar(
    specimen(bar, 'Listening', 'Playing: the button becomes Stop.'),
    toolbarProps({ listen: { ...IDLE, status: 'playing', slow: true } }),
  );
  mountToolbar(
    specimen(bar, 'Finished', 'Replay after playback ended.'),
    toolbarProps({ listen: { ...IDLE, status: 'ended' } }),
  );
  mountToolbar(
    specimen(bar, 'Online voice', 'Playing with the one-time privacy note.'),
    toolbarProps({ listen: { ...IDLE, status: 'playing', note: t('speechRemoteNote') } }),
  );
  mountToolbar(
    specimen(bar, 'No voice (Linux)', 'No speech engine: message, install hint, Voice settings.'),
    toolbarProps({
      listen: {
        ...IDLE,
        status: 'unavailable',
        message: t('speechNoVoice'),
        hint: t('speechNoVoiceLinuxHint'),
      },
    }),
  );
  mountToolbar(
    specimen(bar, 'Only online voices', 'Voices exist but all send text online.'),
    toolbarProps({ listen: { ...IDLE, status: 'unavailable', message: t('speechOnlineOnly') } }),
  );
  mountToolbar(
    specimen(bar, 'Voice did not start', 'A voice was found but never produced audio.'),
    toolbarProps({ listen: { ...IDLE, status: 'failed', message: t('speechStartFailed') } }),
  );
  mountToolbar(
    specimen(bar, 'Selection too long', 'Over 2,000 characters: the one trim action.'),
    toolbarProps({ mode: 'too-long' }, 'passage'),
  );
  mountToolbar(
    specimen(bar, 'Trimmed', 'After "Use first 2,000 characters": exact text preview.'),
    toolbarProps(
      { mode: 'too-long', trimmed: { text: SAMPLE_PASSAGE, length: SAMPLE_PASSAGE.length } },
      'passage',
    ),
  );
  mountToolbar(
    specimen(bar, 'Notice', 'A message that is not about a selection.'),
    toolbarProps({ mode: 'notice', notice: t('toolbarNoticeFrameAccess') }),
  );
  mountToolbar(
    specimen(bar, 'Explain working', 'The state line before the card draws.'),
    toolbarProps({
      busy: 'explain',
      card: { action: 'explain', text: SAMPLE_WORD, note: t('toolbarWorking') },
    }),
  );

  // ---- Card ----
  const cards = section(
    'Explanation card (components/explanation: ExplanationCard.tsx + card.css)',
  );
  const word = SAMPLE_WORD;
  mountCardSpecimen(
    specimen(cards, 'Loading', 'Request in flight (never resolves here).'),
    'loading',
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'Answer: word', 'Core answer; switch tabs to load the others.'),
    'answer',
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'Answer: sentence', 'Sentence tabs; Translate is on in the shipped build.'),
    'answer',
    SAMPLE_SENTENCE,
    'sentence',
    (session) => setTimeout(() => session.selectTab('simplify'), 600),
  );
  mountCardSpecimen(
    specimen(cards, 'Long answer', 'Over 700 characters: the side panel note.'),
    'answer',
    SAMPLE_PASSAGE,
    'passage',
    (session) => setTimeout(() => session.selectTab('simplify'), 600),
  );
  mountCardSpecimen(
    specimen(cards, 'First send (disclosure)', 'The one-time "Send this to Groq?" confirmation.'),
    { kind: 'disclosure' },
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'No key', 'Connect Groq.'),
    { kind: 'error', code: 'SETUP_REQUIRED' },
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'Invalid key', 'Groq rejected the key.'),
    { kind: 'error', code: 'INVALID_API_KEY' },
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'Rate limited', 'Retry is refused until the delay passes.'),
    { kind: 'error', code: 'RATE_LIMITED', retryAfterMs: 20_000 },
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'Own throttle', "Clavis's per-tab limit, not Groq's."),
    { kind: 'error', code: 'RATE_LIMITED', reason: 'local-limit', retryAfterMs: 8000 },
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'Network error', 'Connection problem, with Retry.'),
    { kind: 'error', code: 'NETWORK_ERROR' },
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'Timeout', 'Groq took too long.'),
    { kind: 'error', code: 'TIMEOUT' },
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'Model unavailable', 'Choose another model in Settings.'),
    { kind: 'error', code: 'MODEL_UNAVAILABLE' },
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'Unusable reply', 'The model returned the wrong format.'),
    { kind: 'error', code: 'INVALID_RESPONSE' },
    word,
    'word',
  );
  mountCardSpecimen(
    specimen(cards, 'Cancelled', 'Quiet "not loaded" note with Load.'),
    { kind: 'error', code: 'REQUEST_CANCELLED' },
    word,
    'word',
  );
}

build();

import.meta.hot?.dispose(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
import.meta.hot?.accept();
