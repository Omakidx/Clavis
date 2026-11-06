import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';

// FR-016, automated: axe against the production toolbar VIEW and stylesheet, rendered into an
// OPEN shadow root on a test-only page (the shipped root is closed, which axe cannot enter, see
// tests/e2e/p4-toolbar-support/a11y-entry.mjs). Keyboard, focus and live-region behaviour of the
// shipped closed-root toolbar is covered in p4-toolbar-coverage.spec.ts and p4-toolbar-limit.spec.ts.
const root = fileURLToPath(new URL('../../', import.meta.url));
const css = readFileSync(path.join(root, 'components/tooltip/toolbar.css'), 'utf8');
const catalog = JSON.parse(
  readFileSync(path.join(root, 'public/_locales/en/messages.json'), 'utf8'),
) as Record<string, unknown>;

let browser: Browser;
let bundle = '';

test.beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium' });
  const result = await build({
    entryPoints: [path.join(root, 'tests/e2e/p4-toolbar-support/a11y-entry.mjs')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__toolbar',
    platform: 'browser',
    alias: { 'wxt/browser': path.join(root, 'tests/e2e/p4-toolbar-support/browser-stub.ts') },
    define: { 'import.meta.env.DEV': 'false' },
  });
  bundle = result.outputFiles[0]?.text ?? '';
});

test.afterAll(async () => {
  await browser?.close();
});

type Props = Record<string, unknown>;

/** Listen's view state (Phase 6): what `ToolbarViewProps.listen` carries. */
const IDLE = { status: 'idle', slow: false, message: '', hint: '', note: '' };

const BASE: Props = {
  mode: 'actions',
  kind: 'word',
  notice: '',
  card: null,
  trimmed: null,
  busy: null,
  listen: IDLE,
  live: '',
  tabStop: 'listen',
};

const STATES: Array<{ name: string; props: Props }> = [
  { name: 'Listen and Explain', props: BASE },
  {
    name: 'working',
    props: {
      ...BASE,
      busy: 'explain',
      tabStop: 'explain',
      card: { action: 'explain', text: 'cartographer', note: 'Working on it…' },
      live: 'Working on it…',
    },
  },
  {
    name: 'Listen starting (spinner)',
    props: { ...BASE, listen: { ...IDLE, status: 'starting' }, live: 'Starting playback…' },
  },
  {
    name: 'Listen playing (Stop) with Slow on and the online-voice note',
    props: {
      ...BASE,
      listen: {
        ...IDLE,
        status: 'playing',
        slow: true,
        note: 'This voice sends the text to an online service.',
      },
      live: 'Playing.',
    },
  },
  {
    name: 'Listen ended (Replay)',
    props: { ...BASE, listen: { ...IDLE, status: 'ended' } },
  },
  {
    name: 'Listen ended by an error',
    props: {
      ...BASE,
      listen: {
        ...IDLE,
        status: 'ended',
        message: 'Playback stopped unexpectedly. Press Replay to try again.',
      },
      live: 'Playback stopped unexpectedly. Press Replay to try again.',
    },
  },
  {
    name: 'no voice on Linux (message, hint and Voice settings)',
    props: {
      ...BASE,
      listen: {
        ...IDLE,
        status: 'unavailable',
        message: "Voice isn't available on this device.",
        hint: 'Install speech-dispatcher and a voice such as espeak-ng, then restart Chrome.',
      },
      live: "Voice isn't available on this device. Install speech-dispatcher and a voice such as espeak-ng, then restart Chrome.",
    },
  },
  {
    name: 'Selection too long',
    props: {
      ...BASE,
      mode: 'too-long',
      kind: 'passage',
      tabStop: 'trim',
      live: 'Selection too long. Choose Use the first 2,000 characters to continue.',
    },
  },
  {
    name: 'trimmed preview',
    props: {
      ...BASE,
      kind: 'passage',
      trimmed: { text: 'word0 word1 word2 '.repeat(120).trim(), length: 2000 },
      live: 'Using the first 2,000 characters',
    },
  },
  {
    name: 'error',
    props: {
      ...BASE,
      card: {
        action: 'explain',
        text: 'bank',
        note: "That didn't work. Press the button to try again.",
      },
      live: "That didn't work. Press the button to try again.",
    },
  },
  {
    name: 'notice',
    props: {
      ...BASE,
      mode: 'notice',
      tabStop: 'close',
      notice:
        "Clavis can't read text inside this embedded frame without website access. Select text outside the frame, or turn on website access for Clavis in Settings.",
    },
  },
];

async function renderState(page: Page, props: Props): Promise<void> {
  await page.evaluate(
    ({ state, styles }) => {
      const host = document.getElementById('host') as HTMLElement;
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
      const mount = (
        window as unknown as {
          __toolbar: { mount(r: ShadowRoot, p: unknown, c: string): HTMLElement };
        }
      ).__toolbar.mount;
      const container = mount(shadow, { ...state, onAction: () => undefined }, styles);
      const panel = container.firstElementChild as HTMLElement;
      // The real shell places the panel with inline left/top; any in-viewport spot will do here.
      panel.style.left = '24px';
      panel.style.top = '120px';
    },
    { state: props, styles: css },
  );
}

async function openPage(
  options: {
    colorScheme?: 'light' | 'dark';
    forcedColors?: 'active';
    reducedMotion?: 'reduce';
    width?: number;
  } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1000, height: 700 },
    colorScheme: options.colorScheme ?? 'light',
    ...(options.forcedColors === undefined ? {} : { forcedColors: options.forcedColors }),
    ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
  });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>Toolbar fixture</title></head>
     <body style="margin:0;background:${options.colorScheme === 'dark' ? '#10141a' : '#fff'};color:${options.colorScheme === 'dark' ? '#e8ecf1' : '#1b1f24'}">
       <main><h1>Fixture page</h1><p>Ordinary page text.</p><div id="host"></div></main>
     </body></html>`,
  );
  await page.evaluate((messages) => {
    (window as unknown as { __clavisMessages: unknown }).__clavisMessages = messages;
  }, catalog);
  await page.addScriptTag({ content: bundle });
  return page;
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe, ${scheme} colour scheme`, () => {
    for (const state of STATES) {
      test(`${state.name}: no accessibility violations`, async () => {
        const page = await openPage({ colorScheme: scheme });
        try {
          await renderState(page, state.props);
          const results = await new AxeBuilder({ page }).analyze();
          const summary = results.violations.map(
            (v) =>
              `${v.impact ?? 'n/a'} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          );
          expect(summary, summary.join('\n')).toEqual([]);
          // The toolbar really was inspected: axe sees into the open root.
          const inspected = await page.evaluate(
            () =>
              document.getElementById('host')?.shadowRoot?.querySelectorAll('button').length ?? 0,
          );
          expect(inspected).toBeGreaterThan(0);
        } finally {
          await page.context().close();
        }
      });
    }
  });
}

test.describe('structure and targets', () => {
  test('the toolbar has a role and a name, buttons are native and named', async () => {
    const page = await openPage();
    try {
      await renderState(page, BASE);
      const shape = await page.evaluate(() => {
        const root = document.getElementById('host')?.shadowRoot as ShadowRoot;
        const toolbar = root.querySelector('[role="toolbar"]') as HTMLElement;
        return {
          label: toolbar.getAttribute('aria-label'),
          buttons: Array.from(root.querySelectorAll('button'), (b) => ({
            type: b.type,
            name: b.textContent,
            tabIndex: b.tabIndex,
          })),
          live: root.querySelector('[role="status"]')?.getAttribute('data-clavis'),
        };
      });
      expect(shape.label).toBe('Clavis actions for the selected text');
      expect(shape.buttons).toEqual([
        { type: 'button', name: 'Lookup', tabIndex: 0 },
        { type: 'button', name: 'Speak', tabIndex: 0 },
        { type: 'button', name: '0.75×', tabIndex: 0 },
      ]);
      expect(shape.live).toBe('live');
    } finally {
      await page.context().close();
    }
  });

  for (const state of STATES) {
    test(`${state.name}: every control is at least 24 x 24 CSS pixels (WCAG 2.2 target size)`, async () => {
      const page = await openPage();
      try {
        await renderState(page, state.props);
        const sizes = await page.evaluate(() =>
          Array.from(
            (document.getElementById('host')?.shadowRoot as ShadowRoot).querySelectorAll('button'),
            (b) => {
              const r = b.getBoundingClientRect();
              return { name: b.textContent, width: r.width, height: r.height };
            },
          ),
        );
        expect(sizes.length).toBeGreaterThan(0);
        for (const size of sizes) {
          expect(size.width, `${size.name} width`).toBeGreaterThanOrEqual(24);
          expect(size.height, `${size.name} height`).toBeGreaterThanOrEqual(24);
        }
      } finally {
        await page.context().close();
      }
    });
  }

  test('works at 200% zoom and at 320 px: nothing overflows, long labels wrap', async () => {
    // 200% zoom of a 640 px window is a 320 px layout viewport.
    const page = await openPage({ width: 320 });
    try {
      for (const state of STATES) {
        await renderState(page, state.props);
        const box = await page.evaluate(() => {
          const panel = (document.getElementById('host')?.shadowRoot as ShadowRoot).querySelector(
            '.panel',
          ) as HTMLElement;
          panel.style.left = '8px';
          const r = panel.getBoundingClientRect();
          return {
            right: r.right,
            pageOverflow:
              document.documentElement.scrollWidth > document.documentElement.clientWidth,
            childOverflow: Array.from(panel.querySelectorAll('*')).some(
              (el) => el.getBoundingClientRect().right > r.right + 0.5,
            ),
          };
        });
        expect(box.right, state.name).toBeLessThanOrEqual(320);
        expect(box.pageOverflow, state.name).toBe(false);
        expect(box.childOverflow, state.name).toBe(false);
      }
    } finally {
      await page.context().close();
    }
  });
});

test.describe('user preferences', () => {
  test('prefers-reduced-motion: no transitions, and the Listen spinner stops rotating', async () => {
    const reduced = await openPage({ reducedMotion: 'reduce' });
    const normal = await openPage();
    try {
      const motion = async (page: Page): Promise<{ transition: string; spinner: string }> => {
        await renderState(page, { ...BASE, listen: { ...IDLE, status: 'starting' } });
        return page.evaluate(() => {
          const root = document.getElementById('host')?.shadowRoot as ShadowRoot;
          return {
            transition: getComputedStyle(root.querySelector('button') as Element)
              .transitionDuration,
            spinner: getComputedStyle(root.querySelector('.spinner') as Element).animationName,
          };
        });
      };
      expect(await motion(reduced)).toEqual({ transition: '0s', spinner: 'none' });
      // The only motion in the toolbar is that spinner, and only without a reduced-motion request.
      expect(await motion(normal)).toEqual({ transition: '0s', spinner: 'clavis-spin' });
    } finally {
      await reduced.context().close();
      await normal.context().close();
    }
  });

  test('prefers-color-scheme: the toolbar inverts for dark, with readable text in both', async () => {
    const colours: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      const page = await openPage({ colorScheme: scheme });
      try {
        await renderState(page, BASE);
        colours.push(
          await page.evaluate(
            () =>
              getComputedStyle(
                (document.getElementById('host')?.shadowRoot as ShadowRoot).querySelector(
                  '.toolbar',
                ) as Element,
              ).backgroundColor,
          ),
        );
      } finally {
        await page.context().close();
      }
    }
    expect(colours[0]).not.toBe(colours[1]);
  });

  test('forced-colors (high contrast): system colours, a real border and a focus surface', async () => {
    const page = await openPage({ forcedColors: 'active' });
    try {
      await renderState(page, {
        ...BASE,
        listen: { ...IDLE, status: 'playing', slow: true },
        card: { action: 'explain', text: 'bank', note: 'x' },
      });
      const styles = await page.evaluate(async () => {
        const root = document.getElementById('host')?.shadowRoot as ShadowRoot;
        const toolbar = getComputedStyle(root.querySelector('.toolbar') as Element);
        const button = root.querySelector('button') as HTMLButtonElement;
        button.focus();
        const focused = getComputedStyle(button);
        const focusedBackground = focused.backgroundColor;
        button.blur();
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        return {
          toolbarBorder: toolbar.borderTopWidth,
          buttonBorder: getComputedStyle(button).borderTopWidth,
          pressedBorder: getComputedStyle(root.querySelector('[aria-pressed="true"]') as Element)
            .borderTopWidth,
          outline: focused.outlineStyle,
          focusedBackground,
          restingBackground: getComputedStyle(button).backgroundColor,
          matches: matchMedia('(forced-colors: active)').matches,
        };
      });
      expect(styles.matches).toBe(true);
      // Stop (playing) and a pressed Slow toggle stay distinguishable without colour: a border.
      expect(styles.pressedBorder).toBe('1px');
      expect(styles.toolbarBorder).toBe('1px');
      expect(styles.buttonBorder).toBe('1px');
      expect(styles.outline).toBe('none');
      expect(styles.focusedBackground).not.toBe(styles.restingBackground);
    } finally {
      await page.context().close();
    }
  });

  test('keyboard focus changes the button surface without an outline ring', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const page = await openPage({ colorScheme: scheme });
      try {
        await renderState(page, BASE);
        // The page has nothing else focusable: the first Tab lands on the toolbar's first button.
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(async () => {
          const root = document.getElementById('host')?.shadowRoot as ShadowRoot;
          const focused = root.activeElement as HTMLElement | null;
          if (focused === null) return null;
          const style = getComputedStyle(focused);
          const focusedBackground = style.backgroundColor;
          const visible = focused.matches(':focus-visible');
          const outline = style.outlineStyle;
          focused.blur();
          await new Promise((resolve) => window.setTimeout(resolve, 200));
          return {
            name: focused.textContent,
            visible,
            outline,
            focusedBackground,
            restingBackground: getComputedStyle(focused).backgroundColor,
          };
        });
        expect(focus?.name, scheme).toBe('Lookup');
        expect(focus?.visible, scheme).toBe(true);
        expect(focus?.outline, scheme).toBe('none');
        expect(focus?.focusedBackground, scheme).not.toBe(focus?.restingBackground);
      } finally {
        await page.context().close();
      }
    }
  });
});
