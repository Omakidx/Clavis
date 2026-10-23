import type { Route } from '@playwright/test';
import { CARD, overrideChat, type CardProbe } from '../p5-card-support/harness';
import type { ChatBody } from '../p5-support/groq';
import type { BrowserContext } from '@playwright/test';

/** What an error state of the card shows a person: its code, its text and its buttons. */
export interface ErrorShape {
  code: string | null;
  offline: string | null;
  text: string;
  buttons: { label: string; inactive: string | null }[];
}

export async function errorShape(card: CardProbe): Promise<ErrorShape> {
  const shape = await card.toolbar.evalIn<ErrorShape>(
    CARD.error,
    `function () {
      return {
        code: this.getAttribute('data-code'),
        offline: this.getAttribute('data-offline'),
        text: this.textContent,
        buttons: Array.from(this.querySelectorAll('button')).map((b) => ({
          label: b.textContent, inactive: b.getAttribute('aria-disabled'),
        })),
      };
    }`,
  );
  if (shape === undefined) throw new Error('the card shows no error');
  return shape;
}

/** All text inside the card's closed root (what a person could read), for leak scans. */
export async function cardText(card: CardProbe): Promise<string> {
  return (
    (await card.toolbar.evalIn<string>(
      null,
      `function () { return this.textContent + ' ' + this.innerHTML; }`,
    )) ?? ''
  );
}

export type ChatHandler = (route: Route, mode: string, word: string) => Promise<void> | void;

/**
 * One controllable override of the chat completions route: tests set `script.handler` for the
 * scenario at hand; with none set every request falls through to the harness's fake Groq.
 */
export interface Script {
  handler: ChatHandler | undefined;
  /** Every chat request the override saw, in the order they arrived (with its parsed body). */
  seen: { mode: string; word: string; body: ChatBody; authorization: string | undefined }[];
}

export async function installScript(context: BrowserContext): Promise<Script> {
  const script: Script = { handler: undefined, seen: [] };
  await overrideChat(context, async (route, mode, word) => {
    script.seen.push({
      mode,
      word,
      body: route.request().postDataJSON() as ChatBody,
      authorization: (await route.request().headerValue('authorization')) ?? undefined,
    });
    if (script.handler === undefined) return route.fallback();
    return script.handler(route, mode, word);
  });
  return script;
}

/** Resolve after `ms` (a plain wait for "nothing happens" checks). */
export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
