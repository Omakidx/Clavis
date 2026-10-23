import type { Page } from '@playwright/test';
import { FAKE_KEY, openExtensionPage, send } from '../p3-support/background';
import { fakeGroq, type ChatBody, type FakeGroq } from '../p5-support/groq';
import { launchExtension, type LaunchedExtension } from '../spike-b-support/extension';
import { trackGroqRequests } from '../spike-b-support/page';
import { openReaderPage, type Reader } from './reader';

/**
 * One Chromium with the BUILT extension (and a fake Groq) per spec file. Every test opens its own
 * reader tab and closes it again, so tests do not share reader state. Fake keys start with
 * `gsk_TEST`; nothing reaches the real Groq or any other host.
 */
export interface AcceptHarness {
  ext: LaunchedExtension;
  groq: FakeGroq;
  /** Every request to api.groq.com seen by any page or worker. */
  groqUrls: string[];
  /** Every request of the browser context; `openReader` clears it, so it covers one tab's life. */
  requests: string[];
  /**
   * Web (http, https, ws) requests from ANY page or worker that were not meant for the fake Groq.
   * They are aborted, so nothing can leave the test machine; `openReader` clears the list.
   * Playwright's plain `request` event does not see requests made by dedicated workers (the PDF.js
   * worker), a route does: `canary` in p7-accept-open.spec.ts proves it.
   */
  webRequests: string[];
  /** The extension's Settings tab (used to store the key and to ask for voices). */
  options: Page;
  openReader(viewport?: { width: number; height: number }): Promise<Reader>;
  /** True when no speech engine reports a voice on this machine. */
  noVoices(): Promise<boolean>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Store a (fake) key. Default false. */
  key?: boolean;
  /** Acknowledge the Explain data disclosure (as onboarding does). Default: same as `key`. */
  acknowledged?: boolean;
}

export async function startAcceptHarness(options: HarnessOptions = {}): Promise<AcceptHarness> {
  const ext = await launchExtension();
  const groqUrls = trackGroqRequests(ext.context);
  const groq = await fakeGroq(ext.context);
  const requests: string[] = [];
  const webRequests: string[] = [];
  ext.context.on('request', (request) => requests.push(request.url()));
  // Registered after fakeGroq, so it runs first: Groq falls through, everything else is recorded and blocked.
  await ext.context.route(/^(https?|wss?):\/\//, (route) => {
    const url = route.request().url();
    const host = new URL(url).hostname;
    // Groq goes to the fake; the local fixture server is judged by `requests` (foreignRequests).
    if (host === 'api.groq.com' || host === '127.0.0.1' || host === 'localhost') {
      return route.fallback();
    }
    webRequests.push(url);
    return route.abort('blockedbyclient');
  });
  const optionsPage = await openExtensionPage(ext.context, ext.extensionId, 'options');
  if (options.key === true) {
    await send(optionsPage, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
  }
  if (options.acknowledged ?? options.key === true) {
    await send(optionsPage, { v: 1, type: 'ACCEPT_DISCLOSURE' });
  }
  // Storing the key verifies it against /models: not part of any test's counts.
  groq.reset();
  groqUrls.length = 0;
  return {
    ext,
    groq,
    groqUrls,
    requests,
    webRequests,
    options: optionsPage,
    openReader: async (viewport) => {
      const reader = await openReaderPage(ext.context, ext.extensionId, requests, viewport);
      webRequests.length = 0;
      return reader;
    },
    async noVoices() {
      const report = await send(optionsPage, { v: 1, type: 'GET_VOICES' });
      // The engine list changes between phases (the offscreen engine was removed); count what is there.
      const engines = (
        report?.data as { engines?: Record<string, { voices?: unknown[] }> } | undefined
      )?.engines;
      if (report?.ok !== true || engines === undefined) return false;
      return Object.values(engines).every((engine) => (engine.voices?.length ?? 0) === 0);
    },
    close: () => ext.close(),
  };
}

export interface PromptParts {
  task: string;
  before: string | undefined;
  selected: string;
  after: string | undefined;
}

/** What the prompt builder does to quoted text: ASCII angle brackets become entities. */
export const escapeAngles = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Split the user message of a chat completion into the task line and the three quoted blocks, as
 * sent (angle brackets escaped: compare with `escapeAngles(expected)`).
 */
export function promptParts(body: ChatBody | undefined): PromptParts {
  const user = body?.messages.find((m) => m.role === 'user')?.content ?? '';
  const block = (tag: string): string | undefined => {
    const match = new RegExp(`<${tag}_[0-9a-f]+>([\\s\\S]*?)</${tag}_[0-9a-f]+>`).exec(user);
    return match?.[1];
  };
  const selected = block('selected_text');
  if (selected === undefined) throw new Error(`no selected_text block in: ${user.slice(0, 200)}`);
  return {
    task: /^Task: (.*)$/m.exec(user)?.[1] ?? '',
    before: block('context_before'),
    selected,
    after: block('context_after'),
  };
}
