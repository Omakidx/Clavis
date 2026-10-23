import type { BrowserContext, Page, Worker } from '@playwright/test';

/** `chrome.*` inside page / worker evaluate callbacks (tsconfig.node.json has no chrome types). */
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    getContexts(filter: { contextTypes: string[] }): Promise<{ documentUrl?: string }[]>;
  };
  offscreen: { closeDocument(): Promise<void> };
};

export interface SpeechReply {
  ok: boolean;
  requestId?: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; reason?: string };
}

export interface VoicesReply {
  ok: boolean;
  data?: {
    platform: string;
    defaultEngine: string;
    engines: {
      chromeTts: { voices: { name: string; lang?: string; engine: string; remote: boolean }[] };
      offscreen: {
        available: boolean;
        voices: { name: string; lang?: string; engine: string; remote: boolean }[];
      };
    };
  };
  error?: { code: string; message: string };
}

export const newId = (): string => crypto.randomUUID();

export const WORD = 'bank';
export const SENTENCE =
  'The river bank was steep, so we walked along the water slowly; it was a quiet afternoon.';

export const speakMessage = (text: string, over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'TTS_SPEAK',
  requestId: newId(),
  text,
  rate: 1,
  ...over,
});

export async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  name: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${name}.html`);
  return page;
}

/** Send a runtime message from an extension page, exactly as the UI would. */
export function sendFromPage(page: Page, message: unknown): Promise<unknown> {
  return page.evaluate((m) => chrome.runtime.sendMessage(m), message);
}

/** Offscreen documents currently open, read from the service worker. */
export function offscreenDocuments(worker: Worker): Promise<{ documentUrl?: string }[]> {
  return worker.evaluate(() =>
    chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }),
  );
}

export function closeOffscreen(worker: Worker): Promise<void> {
  return worker.evaluate(() => chrome.offscreen.closeDocument());
}
