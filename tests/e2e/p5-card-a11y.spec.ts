import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';

// Phase 5, explanation card: axe against the REAL card (view, session, stylesheet) rendered into
// an OPEN shadow root on a test-only page (the shipped root is closed, which axe cannot enter; see
// tests/e2e/p5-card-support/a11y-entry.mjs). Keyboard, focus and layout in the shipped closed-root
// build are covered by p5-card-keyboard.spec.ts.
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');
const css = [read('components/tooltip/toolbar.css'), read('components/explanation/card.css')];
const catalog = JSON.parse(read('public/_locales/en/messages.json')) as Record<string, unknown>;

let browser: Browser;
let bundle = '';

test.beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium' });
  const result = await build({
    entryPoints: [path.join(root, 'tests/e2e/p5-card-support/a11y-entry.mjs')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__card',
    platform: 'browser',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    alias: { 'wxt/browser': path.join(root, 'tests/e2e/p4-toolbar-support/browser-stub.ts') },
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'text' },
  });
  bundle = result.outputFiles[0]?.text ?? '';
});
test.afterAll(async () => {
  await browser?.close();
});

interface Scenario {
  name: string;
  scenario: string;
  kind?: string;
  keyboard?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: 'loading', scenario: 'loading' },
  { name: 'core answer', scenario: 'core' },
  { name: 'core answer, keyboard run', scenario: 'core', keyboard: true },
  { name: 'Roots tab (uncertain origin)', scenario: 'roots' },
  { name: 'sentence tabs', scenario: 'core', kind: 'sentence' },
  { name: 'first-send confirmation', scenario: 'disclosure', keyboard: true },
  { name: 'error: Connect Groq', scenario: 'error:SETUP_REQUIRED' },
  { name: 'error: Update key', scenario: 'error:INVALID_API_KEY' },
  { name: 'error: Choose another model', scenario: 'error:MODEL_UNAVAILABLE' },
  { name: 'error: rate limit countdown', scenario: 'error:RATE_LIMITED' },
  { name: "error: Can't connect", scenario: 'error:NETWORK_ERROR' },
  { name: "error: Couldn't format explanation", scenario: 'error:INVALID_RESPONSE' },
  { name: 'quiet: not loaded', scenario: 'error:REQUEST_CANCELLED' },
];

async function openPage(
  options: {
    colorScheme?: 'light' | 'dark';
    forcedColors?: 'active';
    reducedMotion?: 'reduce';
    width?: number;
    height?: number;
  } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1000, height: options.height ?? 700 },
    colorScheme: options.colorScheme ?? 'light',
    ...(options.forcedColors === undefined ? {} : { forcedColors: options.forcedColors }),
    ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
  });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>Card fixture</title></head>
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

async function render(page: Page, scenario: Scenario): Promise<void> {
  await page.evaluate(
    async ({ s, styles }) => {
      const host = document.getElementById('host') as HTMLElement;
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
      const api = (
        window as unknown as { __card: { show(r: ShadowRoot, o: unknown): Promise<void> } }
      ).__card;
      await api.show(shadow, { ...s, css: styles });
    },
    { s: scenario, styles: css },
  );
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe, ${scheme} colour scheme`, () => {
    for (const scenario of SCENARIOS) {
      test(`${scenario.name}: no accessibility violations`, async () => {
        const page = await openPage({ colorScheme: scheme });
        try {
          await render(page, scenario);
          const results = await new AxeBuilder({ page }).analyze();
          const summary = results.violations.map(
            (v) =>
              `${v.impact ?? 'n/a'} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          );
          expect(summary, summary.join('\n')).toEqual([]);
          // The card really was inspected: axe sees into the open root.
          const inspected = await page.evaluate(
            () =>
              document
                .getElementById('host')
                ?.shadowRoot?.querySelectorAll('[data-clavis="card"] button').length ?? 0,
          );
          expect(inspected).toBeGreaterThan(0);
        } finally {
          await page.context().close();
        }
      });
    }
  });
}

test.describe('structure, targets and preferences', () => {
  test('tabs, panels and the live region are wired as the tabs pattern asks', async () => {
    const page = await openPage();
    try {
      await render(page, { name: 'core', scenario: 'core' });
      const shape = await page.evaluate(() => {
        const rootNode = document.getElementById('host')?.shadowRoot as ShadowRoot;
        const tabs = Array.from(rootNode.querySelectorAll('[role="tab"]'));
        return {
          region: rootNode.querySelector('[data-clavis="card"]')?.getAttribute('aria-label'),
          list: rootNode.querySelector('[role="tablist"]')?.getAttribute('aria-label'),
          tabs: tabs.map((tab) => {
            const panel = rootNode.getElementById?.(tab.getAttribute('aria-controls') ?? '');
            return {
              name: tab.textContent,
              selected: tab.getAttribute('aria-selected'),
              tabindex: tab.getAttribute('tabindex'),
              panelRole: panel?.getAttribute('role') ?? null,
              panelLabelledBy: panel?.getAttribute('aria-labelledby') === tab.id,
              panelHidden: panel?.hasAttribute('hidden') ?? null,
            };
          }),
          live: rootNode.querySelector('[role="status"]')?.getAttribute('data-clavis'),
          liveText: rootNode.querySelector('[role="status"]')?.textContent,
        };
      });
      expect(shape.region).toBe('Explanation of bank');
      expect(shape.list).toBe('Explanation sections');
      expect(shape.tabs).toEqual([
        {
          name: 'Core',
          selected: 'true',
          tabindex: '0',
          panelRole: 'tabpanel',
          panelLabelledBy: true,
          panelHidden: false,
        },
        {
          name: 'Roots',
          selected: 'false',
          tabindex: '-1',
          panelRole: 'tabpanel',
          panelLabelledBy: true,
          panelHidden: true,
        },
        {
          name: 'Related words',
          selected: 'false',
          tabindex: '-1',
          panelRole: 'tabpanel',
          panelLabelledBy: true,
          panelHidden: true,
        },
      ]);
      expect(shape.live).toBe('card-live');
      expect(shape.liveText).toBe('Explanation ready.');
    } finally {
      await page.context().close();
    }
  });

  for (const scenario of SCENARIOS) {
    test(`${scenario.name}: every control is at least 24 x 24 CSS pixels (WCAG 2.2 target size)`, async () => {
      const page = await openPage();
      try {
        await render(page, scenario);
        const sizes = await page.evaluate(() =>
          Array.from(
            (document.getElementById('host')?.shadowRoot as ShadowRoot).querySelectorAll('button'),
            (b) => {
              const r = b.getBoundingClientRect();
              return { name: b.textContent, width: r.width, height: r.height };
            },
          ).filter((size) => size.width > 0),
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

  test('works at 200% zoom and at 320 px: nothing overflows horizontally, the answer scrolls inside the card', async () => {
    const page = await openPage({ width: 320, height: 400 });
    try {
      for (const scenario of SCENARIOS) {
        await render(page, scenario);
        const box = await page.evaluate(() => {
          const rootNode = document.getElementById('host')?.shadowRoot as ShadowRoot;
          const panel = rootNode.querySelector('.panel') as HTMLElement;
          const r = panel.getBoundingClientRect();
          return {
            right: r.right,
            bottom: r.bottom,
            pageOverflow:
              document.documentElement.scrollWidth > document.documentElement.clientWidth,
            childOverflow: Array.from(panel.querySelectorAll('*')).some(
              (el) => el.getBoundingClientRect().right > r.right + 0.5,
            ),
          };
        });
        expect(box.right, scenario.name).toBeLessThanOrEqual(320);
        expect(box.bottom, scenario.name).toBeLessThanOrEqual(400);
        expect(box.pageOverflow, scenario.name).toBe(false);
        expect(box.childOverflow, scenario.name).toBe(false);
      }
    } finally {
      await page.context().close();
    }
  });

  test('prefers-reduced-motion: the loading spinner does not animate', async () => {
    const page = await openPage({ reducedMotion: 'reduce' });
    try {
      await render(page, { name: 'loading', scenario: 'loading' });
      const animation = await page.evaluate(
        () =>
          getComputedStyle(
            (document.getElementById('host')?.shadowRoot as ShadowRoot).querySelector(
              '.ec__spinner',
            ) as Element,
          ).animationName,
      );
      expect(animation).toBe('none');
    } finally {
      await page.context().close();
    }
    const normal = await openPage();
    try {
      await render(normal, { name: 'loading', scenario: 'loading' });
      expect(
        await normal.evaluate(
          () =>
            getComputedStyle(
              (document.getElementById('host')?.shadowRoot as ShadowRoot).querySelector(
                '.ec__spinner',
              ) as Element,
            ).animationName,
        ),
      ).toBe('ec-spin');
    } finally {
      await normal.context().close();
    }
  });

  test('forced-colors (high contrast): the selected tab is marked with a system colour and buttons have borders', async () => {
    const page = await openPage({ forcedColors: 'active' });
    try {
      await render(page, { name: 'core', scenario: 'core' });
      const style = await page.evaluate(() => {
        const rootNode = document.getElementById('host')?.shadowRoot as ShadowRoot;
        const tab = getComputedStyle(rootNode.querySelector('[aria-selected="true"]') as Element);
        const button = getComputedStyle(
          rootNode.querySelector('[data-clavis="card-copy"]') as Element,
        );
        return {
          tabBorder: tab.borderBottomColor,
          tabBorderWidth: tab.borderBottomWidth,
          buttonBorder: button.borderTopWidth,
        };
      });
      // Highlight resolves to a real colour under forced colours, and the border is kept.
      expect(style.tabBorderWidth).toBe('3px');
      expect(style.tabBorder).not.toBe('rgba(0, 0, 0, 0)');
      expect(style.buttonBorder).toBe('1px');
    } finally {
      await page.context().close();
    }
  });

  test('the focus ring is visible on keyboard focus in both colour schemes', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const page = await openPage({ colorScheme: scheme });
      try {
        await render(page, { name: 'core', scenario: 'core' });
        await page.keyboard.press('Tab');
        const ring = await page.evaluate(() => {
          const rootNode = document.getElementById('host')?.shadowRoot as ShadowRoot;
          const active = rootNode.activeElement as HTMLElement | null;
          const s = active ? getComputedStyle(active) : null;
          return { has: active !== null, width: s?.outlineWidth, style: s?.outlineStyle };
        });
        expect(ring.has).toBe(true);
        expect(ring.style).toBe('solid');
        expect(ring.width).toBe('2px');
      } finally {
        await page.context().close();
      }
    }
  });
});
