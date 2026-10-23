import type { BrowserContext, Page } from '@playwright/test';
import { FAKE_KEY, send } from '../p3-support/background';
import { fakeGroq, type FakeGroq } from '../p5-support/groq';
import { openExtensionPage } from '../p3-ui-support/pages';

/** What the explanation request carried, read from the prompt the background built. */
export interface PromptParts {
  mode: string;
  selected: string;
  contextBefore: string;
  contextAfter: string;
}

export function promptParts(content: string): PromptParts {
  const grab = (tag: string) =>
    new RegExp(`<${tag}_\\w+>([\\s\\S]*?)</${tag}_\\w+>`).exec(content)?.[1] ?? '';
  return {
    mode: /\(mode: (\w+)\)/.exec(content)?.[1] ?? '',
    selected: grab('selected_text'),
    contextBefore: grab('context_before'),
    contextAfter: grab('context_after'),
  };
}

export interface AiSetup {
  groq: FakeGroq;
}

/**
 * Give the extension a fake Groq key and answer api.groq.com from the test (nothing leaves the
 * machine). `acknowledged: false` leaves the first-send disclosure unanswered, so the card asks.
 * The setup traffic (key verification) is cleared from the counters before returning.
 */
export async function setUpAi(
  context: BrowserContext,
  extensionId: string,
  options: { acknowledged?: boolean } = {},
): Promise<AiSetup> {
  const groq = await fakeGroq(context);
  const { page } = await openExtensionPage(context, extensionId, 'options');
  await send(page, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
  if (options.acknowledged !== false) await send(page, { v: 1, type: 'ACCEPT_DISCLOSURE' });
  await page.close();
  groq.reset();
  return { groq };
}

/** Whether this machine has any text-to-speech voice (the no-voice assertions skip when it has). */
export async function machineHasVoices(
  context: BrowserContext,
  extensionId: string,
): Promise<boolean> {
  const { page } = await openExtensionPage(context, extensionId, 'options');
  const reply = (await send(page, { v: 1, type: 'GET_VOICES' })) as
    { ok: boolean; data?: { engines: Record<string, { voices: unknown[] }> } } | undefined;
  await page.close();
  const engines = Object.values(reply?.data?.engines ?? {});
  return engines.some((engine) => engine.voices.length > 0);
}

export type { Page };
