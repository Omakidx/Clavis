import { expect, type Page } from '@playwright/test';
import { send } from '../p3-support/background';
import { CARD, cardOf } from '../p5-card-support/harness';
import { loadFixture, openFixtureReady, openReader, setZoom } from '../p7-reader-support/helpers';
import { gotoPage } from '../p7-reader-support/select';
import { openPanelPage, tabIdOf } from '../p8-sidepanel-support/panel';
import { dblclickText } from '../spike-b-support/page';
import { tb } from '../spike-b-support/toolbar';
import { ACCEPT_KEY, type World } from './world';

/**
 * Every screen a person can reach in the extension's own pages, as a named, repeatable state.
 * `open` returns a fresh page in that state. Used by the placeholder and dead-control sweeps.
 */
export interface PageState {
  name: string;
  open(world: World): Promise<Page>;
}

const base = (world: World): string => `chrome-extension://${world.ext.extensionId}`;

/** Put the stored key in the wanted state (a key, acknowledged data notice) through Settings' own routes. */
export async function ensureKey(world: World, wanted: boolean): Promise<void> {
  const page = await world.ext.context.newPage();
  await page.goto(`${base(world)}/options.html`);
  if (wanted) {
    await send(page, { v: 1, type: 'SET_API_KEY', apiKey: ACCEPT_KEY, storage: 'local' });
    await send(page, { v: 1, type: 'ACCEPT_DISCLOSURE' });
  } else {
    await send(page, { v: 1, type: 'REMOVE_API_KEY' });
  }
  await page.close();
}

async function page(world: World, path: string): Promise<Page> {
  const p = await world.ext.context.newPage();
  await p.goto(`${base(world)}/${path}`);
  return p;
}

const next = (p: Page) => p.getByRole('button', { name: 'Next', exact: true });

/** Move the welcome wizard to `step` (1 to 7) by pressing what each screen offers, key not connected. */
async function onboardingAt(world: World, step: number): Promise<Page> {
  await ensureKey(world, false);
  const p = await page(world, 'onboarding.html');
  if (step >= 2) await next(p).click();
  if (step >= 3) {
    const understand = p.getByRole('button', { name: 'I understand' });
    await understand.or(p.getByText("You've already confirmed this")).waitFor();
    if (await understand.isVisible()) await understand.click();
    await next(p).click();
  }
  if (step >= 4) {
    await p.getByRole('button', { name: "Not now — I'll use right-click instead" }).click();
    await next(p).click();
  }
  if (step >= 5) {
    await p.getByRole('button', { name: 'Set up later' }).click();
  }
  if (step >= 6) await next(p).click();
  if (step >= 7) await next(p).click();
  return p;
}

export const ONBOARDING_STATES: PageState[] = [1, 2, 3, 4, 5, 6, 7].map((step) => ({
  name: `onboarding step ${step}`,
  open: (world) => onboardingAt(world, step),
}));

/** The popup on a tab that is a PDF: the only way to fake the tab's address in an ordinary tab. */
async function popupOnPdfTab(world: World): Promise<Page> {
  const p = await world.ext.context.newPage();
  await p.addInitScript(() => {
    chrome.tabs.query = (() =>
      Promise.resolve([
        { id: 1, url: 'https://example.com/paper.pdf' },
      ])) as unknown as typeof chrome.tabs.query;
  });
  await p.goto(`${base(world)}/popup.html`);
  await expect(p.getByTestId('popup-pdf-help')).toBeVisible();
  return p;
}

export const POPUP_STATES: PageState[] = [
  {
    name: 'popup, no key, site access off',
    open: async (world) => {
      await ensureKey(world, false);
      const p = await page(world, 'popup.html');
      await expect(p.getByTestId('popup-groq')).toHaveText('Setup needed');
      return p;
    },
  },
  {
    name: 'popup, connected, site access off',
    open: async (world) => {
      await ensureKey(world, true);
      const p = await page(world, 'popup.html');
      await expect(p.getByTestId('popup-groq')).toHaveText('Connected');
      return p;
    },
  },
  {
    name: 'popup, site access off, its help open',
    open: async (world) => {
      await ensureKey(world, true);
      const p = await page(world, 'popup.html');
      await p.getByText('Using Clavis without website access').click();
      await expect(p.getByTestId('site-access-help')).toBeVisible();
      return p;
    },
  },
  {
    name: 'popup on a PDF tab',
    open: async (world) => {
      await ensureKey(world, true);
      return popupOnPdfTab(world);
    },
  },
];

export const SETTINGS_STATES: PageState[] = [
  {
    name: 'Settings, no key',
    open: async (world) => {
      await ensureKey(world, false);
      const p = await page(world, 'options.html');
      await expect(p.getByTestId('voice-counts')).toBeAttached({ timeout: 15_000 });
      return p;
    },
  },
  {
    name: 'Settings, key connected',
    open: async (world) => {
      await ensureKey(world, true);
      const p = await page(world, 'options.html');
      await expect(p.getByTestId('voice-counts')).toBeAttached({ timeout: 15_000 });
      await expect(p.getByRole('button', { name: 'Remove key' })).toBeVisible();
      return p;
    },
  },
];

/** The practice page, with the selection toolbar already shown on a word. */
export async function practiceWithToolbar(world: World): Promise<Page> {
  const p = await page(world, 'practice.html');
  await expect.poll(() => p.frames().some((f) => f.url() === 'about:srcdoc')).toBe(true);
  const frame = p.frames().find((f) => f.url() === 'about:srcdoc')!;
  await frame.waitForSelector('article p');
  await dblclickText(p, frame, 'bank');
  await tb(frame).waitShown();
  return p;
}

export const PRACTICE_READER_STATES: PageState[] = [
  { name: 'practice page', open: (world) => page(world, 'practice.html') },
  {
    name: 'reader, empty',
    open: async (world) => (await openReader(world.ext.context, world.ext.extensionId)).page,
  },
  {
    name: 'reader, a PDF open',
    open: async (world) => {
      const { page: p } = await openReader(world.ext.context, world.ext.extensionId);
      await openFixtureReady(p, 'text-1page.pdf');
      return p;
    },
  },
  {
    name: 'reader, 100-page PDF on page 2 at 100% zoom',
    open: async (world) => {
      const { page: p } = await openReader(world.ext.context, world.ext.extensionId);
      await openFixtureReady(p, 'text-100pages.pdf');
      await setZoom(p, '1');
      await gotoPage(p, 2);
      return p;
    },
  },
  {
    name: 'reader, damaged file',
    open: async (world) => {
      const { page: p } = await openReader(world.ext.context, world.ext.extensionId);
      await loadFixture(p, 'corrupt.pdf');
      await expect(p.getByTestId('state-error')).toBeVisible();
      return p;
    },
  },
];

/** The side panel of a practice-page card: empty (nothing held) and loaded (a core answer). */
export const PANEL_STATES: PageState[] = [
  {
    name: 'side panel, nothing held',
    open: async (world) => openPanelPage(world.ext.context, world.ext.extensionId, 987_654),
  },
  {
    name: 'side panel, an explanation',
    open: async (world) => {
      await ensureKey(world, true);
      const p = await practiceWithToolbar(world);
      const frame = p.frames().find((f) => f.url() === 'about:srcdoc')!;
      await tb(frame).click('explain');
      const card = cardOf(p, frame);
      await card.waitFor(CARD.ready('core'));
      await card.click(CARD.sidePanel);
      await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
      const tabId = await tabIdOf(world.ext.serviceWorker, p);
      const panel = await openPanelPage(world.ext.context, world.ext.extensionId, tabId);
      await expect(panel.getByTestId('panel-selected')).toBeVisible();
      return panel;
    },
  },
];

export const ALL_STATES: PageState[] = [
  ...ONBOARDING_STATES,
  ...POPUP_STATES,
  ...SETTINGS_STATES,
  ...PRACTICE_READER_STATES,
  ...PANEL_STATES,
];
