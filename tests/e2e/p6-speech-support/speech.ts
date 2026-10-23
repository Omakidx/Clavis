import type { BrowserContext, Page, Worker } from '@playwright/test';

/** `chrome.*` inside page / worker evaluate callbacks (tsconfig.node.json has no chrome types). */
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    getContexts(filter: { contextTypes: string[] }): Promise<{ contextType?: string }[]>;
  };
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

/** Every extension context of this worker's extension, by type (to prove no offscreen document exists). */
export function contextTypes(worker: Worker): Promise<string[]> {
  return worker.evaluate(async () =>
    (
      await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT', 'TAB', 'POPUP', 'BACKGROUND'],
      })
    ).map((context) => (context as { contextType?: string }).contextType ?? ''),
  );
}
