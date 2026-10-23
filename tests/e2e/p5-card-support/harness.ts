import type { BrowserContext, Frame, Page, Route } from '@playwright/test';
import { FAKE_KEY, openExtensionPage, send } from '../p3-support/background';
import { contentWorld, type ContentWorld } from '../p3-support/content-world';
import { fakeGroq, type FakeGroq } from '../p5-support/groq';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from '../spike-b-support/extension';
import { dblclickText, frameOffset, trackGroqRequests } from '../spike-b-support/page';
import { startFixtureServer, type FixtureServer } from '../spike-b-support/server';
import { tb, type ToolbarProbe } from '../spike-b-support/toolbar';

/**
 * The Phase 5 explanation card in the BUILT extension: a fixture server, the extension with site
 * access granted (the registered observer), and Groq answered by the test. Everything else (the
 * observer, the background router, the card script injected by LOAD_EXPLAIN_CARD, the real Groq
 * adapter and prompts) is the real code. Fake keys start with `gsk_TEST`.
 */
export interface CardHarness {
  server: FixtureServer;
  ext: LaunchedExtension;
  groq: FakeGroq;
  /** Every request to api.groq.com seen by any page or the worker, in order (FR-017). */
  groqUrls: string[];
  options: Page;
  /** Open a fixture and wait for the observer to run in it. */
  open(path?: string): Promise<{ page: Page; world: ContentWorld; dispose(): Promise<void> }>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Store a (fake) key. Default true. */
  key?: boolean;
  /** Acknowledge the data disclosure, as onboarding does. Default true. */
  acknowledged?: boolean;
}

export async function startCardHarness(options: HarnessOptions = {}): Promise<CardHarness> {
  const server = await startFixtureServer();
  const ext = await launchExtension({ grantedSiteAccess: true });
  const groqUrls = trackGroqRequests(ext.context);
  const groq = await fakeGroq(ext.context);
  await waitForRegistration(ext.serviceWorker);
  const options_ = await openExtensionPage(ext.context, ext.extensionId, 'options');
  if (options.key !== false) {
    await send(options_, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
  }
  if (options.acknowledged !== false) await send(options_, { v: 1, type: 'ACCEPT_DISCLOSURE' });
  // Setting the key verifies it against /models: not part of any test's counts.
  groq.reset();
  groqUrls.length = 0;
  return {
    server,
    ext,
    groq,
    groqUrls,
    options: options_,
    async open(path = 'article.html') {
      const page = await ext.context.newPage();
      const world = await contentWorld(page);
      await page.goto(`${server.origin}/${path}`);
      await world.ready();
      return {
        page,
        world,
        async dispose() {
          await world.dispose();
          await page.close();
        },
      };
    },
    async close() {
      await ext.close();
      await server.close();
    },
  };
}

/** Answer chat completions with `handler`; anything it does not take falls through to the fake Groq. */
export async function overrideChat(
  context: BrowserContext,
  handler: (route: Route, mode: string, word: string) => Promise<void> | void,
): Promise<void> {
  await context.route('https://api.groq.com/**/chat/completions', async (route) => {
    const body = route.request().postDataJSON() as { messages: { content: string }[] };
    const user = body.messages[1]?.content ?? '';
    const mode = /\(mode: (\w+)\)/.exec(user)?.[1] ?? 'core';
    const word = /<selected_text_\w+>([\s\S]*?)<\/selected_text_\w+>/.exec(user)?.[1]?.trim() ?? '';
    await handler(route, mode, word);
  });
}

/** A chat-completion body whose content is `content` (a string: not necessarily valid JSON). */
export const chatBody = (content: string): string =>
  JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

/** Selectors inside the closed root that belong to the explanation card (components/explanation). */
export const CARD = {
  card: '[data-clavis="card"][data-action="explain"]',
  slot: '[data-clavis="card-slot"]',
  text: '[data-clavis="card-text"]',
  close: '[data-clavis="card-close"]',
  copy: '[data-clavis="card-copy"]',
  model: '[data-clavis="card-model"]',
  live: '[data-clavis="card-live"]',
  confirm: '[data-clavis="card-confirm"]',
  cancel: '[data-clavis="card-cancel"]',
  retry: '[data-clavis="card-retry"]',
  settings: '[data-clavis="card-settings"]',
  disclosure: '[data-clavis="card-disclosure"]',
  error: '[data-clavis="card-error"]',
  tab: (mode: string) => `[data-clavis="card-tab"][data-tab="${mode}"]`,
  panel: (mode: string) => `[data-clavis="card-panel"][data-tab="${mode}"]`,
  ready: (mode: string) => `[data-clavis="card-panel"][data-tab="${mode}"][data-status="ready"]`,
} as const;

/** Reading and driving the card through the DevTools protocol (the root is closed, on purpose). */
export class CardProbe {
  readonly toolbar: ToolbarProbe;
  constructor(
    private readonly page: Page,
    private readonly target: Page | Frame = page,
  ) {
    this.toolbar = tb(target);
  }

  text(selector: string): Promise<string | undefined> {
    return this.toolbar.text(selector);
  }

  exists(selector: string): Promise<boolean> {
    return this.toolbar
      .evalIn<boolean>(selector, 'function () { return true; }')
      .then((value) => value === true);
  }

  /** Wait for an element inside the card (poll: the card renders asynchronously). */
  async waitFor(selector: string, timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        if (await this.exists(selector)) return;
      } catch (error) {
        if (!/Could not find node|No node with given id/.test(String(error))) throw error;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${selector}`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  async waitGone(selector: string, timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        if (!(await this.exists(selector))) return;
      } catch (error) {
        if (!/Could not find node|No node with given id/.test(String(error))) throw error;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${selector} to go away`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  /** Real mouse click on the centre of an element of the card. */
  async click(selector: string): Promise<void> {
    const box = await this.toolbar.box(selector);
    const offset = await frameOffset(this.target);
    await this.page.mouse.click(
      offset.x + box.x + box.width / 2,
      offset.y + box.y + box.height / 2,
    );
  }

  /** Tabs as the user sees them. */
  tabs(): Promise<
    | Array<{
        label: string;
        selected: string | null;
        tabindex: string | null;
        status: string | null;
      }>
    | undefined
  > {
    return this.toolbar.evalIn(
      null,
      `function () {
        return Array.from(this.querySelectorAll('[role="tab"]')).map((el) => ({
          label: el.textContent,
          selected: el.getAttribute('aria-selected'),
          tabindex: el.getAttribute('tabindex'),
          status: el.getAttribute('data-status'),
        }));
      }`,
    );
  }

  /** `data-status` of a tab's panel: idle, queued, loading, ready, disclosure or error. */
  status(mode: string): Promise<string | null | undefined> {
    return this.toolbar.attr(CARD.panel(mode), 'data-status');
  }

  /** Which element inside the closed root has focus: tag, role and a short label. */
  focused(): Promise<string | null | undefined> {
    return this.toolbar.evalIn<string | null>(
      null,
      `function () {
        const a = this.activeElement;
        return a ? (a.getAttribute('data-clavis') || a.getAttribute('role') || a.tagName) + ':' + (a.getAttribute('data-tab') || a.getAttribute('data-action') || '') : null;
      }`,
    );
  }
}

export const cardOf = (page: Page, target: Page | Frame = page): CardProbe =>
  new CardProbe(page, target);

/** Select a word with a real double click and wait for the toolbar. */
export async function selectWord(page: Page, word: string): Promise<void> {
  await dblclickText(page, page, word);
  await tb(page).waitShown();
}

/** Select, press Explain with the mouse, and wait for the card to appear. */
export async function explainWord(page: Page, word: string): Promise<CardProbe> {
  await selectWord(page, word);
  await tb(page).click('explain');
  const card = cardOf(page);
  await card.waitFor(CARD.card);
  return card;
}

/** Everything the explanation card script put in the page's main world: nothing. */
export const MAIN_WORLD_PROBE = `(() => ({
  symbols: Object.getOwnPropertySymbols(globalThis).filter((s) => String(s).includes('clavis')).length,
  names: Object.getOwnPropertyNames(globalThis).filter((n) => /clavis|explain/i.test(n)),
  hostShadow: (() => { const h = document.querySelector(':is(:root, dialog) > div[popover]'); return h ? h.shadowRoot !== null : null; })(),
}))()`;
