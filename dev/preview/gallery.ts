import { toolbarIcon } from './icons';
import { isScenario, type Scenario } from './fake-chrome';
import { parseScheme, type Scheme } from './scheme';
import { resolvePreviewTarget } from './navigation';

/**
 * The preview gallery: one iframe per screen (dev/preview/screen.html), so page-level CSS never
 * leaks between screens and each frame hot-updates by itself. Selection lives in the URL
 * (?screen=&state=&theme=) so a reload or a shared link comes back to the same view.
 */

interface Screen {
  id: string;
  group: string;
  label: string;
  /** Extra query parameters for screen.html. */
  query?: Record<string, string>;
  /** Scenario to use when the user has not picked one (this screen needs a particular situation). */
  state?: Scenario;
  /** Frame size in CSS pixels; omitted = fill the stage. */
  width?: number;
  height?: number;
  note?: string;
}

const ONBOARDING = [
  'Purpose',
  'Data disclosure',
  'Website access',
  'Connect a key',
  'Preferences',
  'Practice',
  'Done',
];

const SCREENS: Screen[] = [
  { id: 'settings', group: 'Pages', label: 'Settings', query: { screen: 'settings' } },
  ...ONBOARDING.map((name, index): Screen => ({
    id: `onboarding-${index + 1}`,
    group: 'Onboarding',
    label: `${index + 1}. ${name}`,
    query: { screen: 'onboarding', step: String(index + 1) },
    // The early steps need a fresh install; later steps need a key so "Next" is available.
    state: index < 4 ? 'fresh' : 'connected',
  })),
  {
    id: 'popup',
    group: 'Pages',
    label: 'Popup',
    query: { screen: 'popup' },
    width: 360,
    height: 600,
    note: 'Toolbar popup, 360 px wide (Chrome allows 25-800).',
  },
  { id: 'practice', group: 'Pages', label: 'Practice page', query: { screen: 'practice' } },
  {
    id: 'sidepanel',
    group: 'Side panel',
    label: 'With hand-off',
    query: { screen: 'sidepanel', tab: '1' },
    width: 400,
    height: 760,
    note: 'Chrome side panels are resizable; roughly 320-600 px wide.',
  },
  {
    id: 'sidepanel-empty',
    group: 'Side panel',
    label: 'Nothing to show',
    query: { screen: 'sidepanel', tab: '1', handoff: 'none' },
    width: 400,
    height: 760,
  },
  { id: 'reader-empty', group: 'PDF reader', label: 'Empty', query: { screen: 'reader' } },
  {
    id: 'reader-text',
    group: 'PDF reader',
    label: 'Sample: one page',
    query: { screen: 'reader', pdf: 'text-1page' },
  },
  {
    id: 'reader-columns',
    group: 'PDF reader',
    label: 'Sample: columns',
    query: { screen: 'reader', pdf: 'multi-column' },
  },
  {
    id: 'reader-links',
    group: 'PDF reader',
    label: 'Sample: links',
    query: { screen: 'reader', pdf: 'links' },
  },
  {
    id: 'reader-image',
    group: 'PDF reader',
    label: 'Image-only (no text)',
    query: { screen: 'reader', pdf: 'image-only' },
  },
  {
    id: 'reader-encrypted',
    group: 'PDF reader',
    label: 'Password prompt',
    query: { screen: 'reader', pdf: 'encrypted' },
  },
  {
    id: 'reader-corrupt',
    group: 'PDF reader',
    label: 'Corrupt file (error)',
    query: { screen: 'reader', pdf: 'corrupt' },
  },
  {
    id: 'webpage',
    group: 'Web page',
    label: 'Toolbar and card states',
    query: { screen: 'webpage' },
    note: 'Real toolbar view and explanation card with their real CSS, one specimen per state.',
  },
];

const nav = document.getElementById('nav') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const segments = document.querySelector<HTMLElement>('.seg') as HTMLElement;
const standalone = document.getElementById('standalone') as HTMLAnchorElement;

const params = new URLSearchParams(location.search);
let screenId = SCREENS.some((s) => s.id === params.get('screen'))
  ? (params.get('screen') ?? '')
  : 'settings';
const stateParam = params.get('state');
/** null = "the screen's own default". */
let chosen: Scenario | null = isScenario(stateParam) ? stateParam : null;
let theme: Scheme = parseScheme(params.get('theme'));

const currentScreen = (): Screen =>
  SCREENS.find((s) => s.id === screenId) ?? (SCREENS[0] as Screen);
const scenarioFor = (screen: Screen): Scenario => chosen ?? screen.state ?? 'connected';

function frameSource(screen: Screen): string {
  const query = new URLSearchParams({
    ...screen.query,
    state: scenarioFor(screen),
    theme,
  });
  return `./screen.html?${query.toString()}`;
}

function syncUrl(): void {
  const next = new URLSearchParams({ screen: screenId, theme });
  if (chosen !== null) next.set('state', chosen);
  history.replaceState(null, '', `?${next.toString()}`);
  document.documentElement.dataset['theme'] = theme === 'system' ? '' : theme;
  if (theme === 'system') delete document.documentElement.dataset['theme'];
}

function frame(): HTMLIFrameElement | null {
  return stage.querySelector('iframe');
}

function postTheme(): void {
  frame()?.contentWindow?.postMessage({ type: 'clavis-preview-theme', theme }, '*');
}

function renderStage(): void {
  const screen = currentScreen();
  const iframe = document.createElement('iframe');
  iframe.title = `${screen.group}: ${screen.label}`;
  iframe.src = frameSource(screen);
  iframe.style.width = screen.width === undefined ? '100%' : `${screen.width}px`;
  iframe.style.height = screen.height === undefined ? 'calc(100vh - 78px)' : `${screen.height}px`;
  iframe.style.minHeight = '320px';
  stage.replaceChildren(iframe);
  standalone.href = frameSource(screen);
  for (const link of nav.querySelectorAll('a')) {
    if (link.dataset['id'] === screenId) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  syncUrl();
}

function select(id: string): void {
  screenId = id;
  // Picking another screen goes back to that screen's own scenario.
  chosen = null;
  renderStage();
}

function buildNav(): void {
  let group = '';
  for (const screen of SCREENS) {
    if (screen.group !== group) {
      group = screen.group;
      const heading = document.createElement('h2');
      heading.textContent = group;
      nav.append(heading);
    }
    const link = document.createElement('a');
    link.href = `?screen=${screen.id}`;
    link.dataset['id'] = screen.id;
    link.textContent = screen.label;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      select(screen.id);
    });
    nav.append(link);
  }
}

function buildControls(): void {
  const system = document.createElement('button');
  system.type = 'button';
  system.append(toolbarIcon('system'));
  system.setAttribute('aria-label', 'Use system appearance');
  system.title = 'Use system appearance';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.append(toolbarIcon('theme'));
  toggle.setAttribute('role', 'switch');
  const updateThemeControls = () => {
    system.setAttribute('aria-pressed', String(theme === 'system'));
    toggle.setAttribute('aria-checked', String(theme === 'dark'));
    toggle.setAttribute('aria-label', 'Dark mode');
    toggle.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  };
  const changeTheme = (next: Scheme) => {
    theme = next;
    updateThemeControls();
    syncUrl();
    postTheme();
    standalone.href = frameSource(currentScreen());
  };
  system.addEventListener('click', () => changeTheme('system'));
  toggle.addEventListener('click', () => changeTheme(theme === 'dark' ? 'light' : 'dark'));
  segments.append(system, toggle);
  updateThemeControls();
  const reload = document.getElementById('reload');
  if (reload) {
    reload.replaceChildren(toolbarIcon('reload'));
    reload.setAttribute('aria-label', 'Reload frame');
    reload.title = 'Reload frame';
  }
  document.getElementById('reload')?.addEventListener('click', renderStage);
}

// An extension page asked to open another page (tabs.create / openOptionsPage / side panel).
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== frame()?.contentWindow || event.origin !== window.location.origin) return;
  const data = event.data as { type?: unknown; url?: unknown } | null;
  if (data === null || typeof data !== 'object' || data.type !== 'clavis-preview-open') return;
  if (typeof data.url !== 'string') return;
  const route = resolvePreviewTarget(data.url, window.location.origin);
  if (route?.kind === 'screen') {
    const keepState = chosen;
    screenId = route.galleryId;
    chosen = keepState;
    renderStage();
    // Section anchors (options.html#section-key) are forwarded to the frame.
    const target = frame();
    if (target !== null && route.hash !== '')
      target.src = `${target.src.split('#')[0]}${route.hash}`;
  } else if (route?.kind === 'external') {
    window.open(route.href, '_blank', 'noopener');
  }
});

buildNav();
buildControls();
renderStage();
