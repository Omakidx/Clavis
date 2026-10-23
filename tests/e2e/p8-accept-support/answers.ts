import type { BrowserContext } from '@playwright/test';
import { chatBody, overrideChat } from '../p5-card-support/harness';

/** How the fake model answers: names the selection, runs long, or writes right-to-left text. */
export type Variant = 'normal' | 'long' | 'rtl';

const SENTENCE = 'A long sentence that keeps going and going so the answer needs room. ';
const longText = (times: number, max: number): string =>
  SENTENCE.repeat(times).trim().slice(0, max);

/** A valid model answer per mode whose text names the selection, so a test can tell whose answer it is reading. */
export function answerFor(mode: string, selected: string, variant: Variant = 'normal'): unknown {
  // A long selection is named by its first words so every field stays inside the schema limits.
  const word = selected.length > 40 ? `${selected.slice(0, 40).trim()}…` : selected;
  if (variant === 'long' && mode === 'core') {
    return {
      title: word,
      summary: longText(8, 590),
      contextualMeaning: longText(11, 790),
      definition: longText(8, 590),
      examples: [
        { sentence: longText(4, 290), note: null },
        { sentence: longText(4, 290), note: null },
      ],
      caveat: longText(5, 390),
    };
  }
  if (variant === 'rtl') {
    switch (mode) {
      case 'core':
        return {
          title: 'ضفة',
          summary: 'الأرض بجانب النهر.',
          contextualMeaning: 'هنا تعني حافة النهر (bank) وليس مصرف الأموال.',
          definition: 'أرض منحدرة على جانب النهر.',
          examples: [
            { sentence: 'صدنا السمك من الضفة.', note: null },
            { sentence: 'Say ضفة to her.', note: null },
          ],
          caveat: null,
        };
      case 'etymology':
        return {
          overview: 'من الجذر العربي ض-ف-ف، ومعناه الجانب.',
          confidence: 'uncertain',
          caveat: null,
        };
      case 'related_words':
        return { synonyms: ['شاطئ', 'حافة'], antonyms: ['وسط'] };
      case 'simplify':
        return { simplifiedText: 'الأرض التي بجانب النهر.', caveat: null };
      default:
        break;
    }
  }
  switch (mode) {
    case 'core':
      return {
        title: word,
        summary: `Summary for ${word}.`,
        contextualMeaning: `Here ${word} means the thing in this sentence.`,
        definition: `Definition of ${word}.`,
        examples: [
          { sentence: `First example with ${word}.`, note: null },
          { sentence: `Second example with ${word}.`, note: null },
        ],
        caveat: null,
      };
    case 'etymology':
      return {
        overview: `Origin of ${word}: from an old root.`,
        confidence: 'known',
        caveat: null,
      };
    case 'related_words':
      return { synonyms: [`${word}-alike`, `${word}-like`], antonyms: [] };
    case 'simplify':
      return { simplifiedText: `Simple version of ${word}.`, caveat: null };
    case 'grammar':
      return { grammar: `Grammar of ${word}.`, caveat: null };
    default:
      return { language: 'French', text: `${word} (fr)`, literal: null, caveat: null };
  }
}

export interface ChatCall {
  mode: string;
  word: string;
}

/** What the fake model does next: answer in a variant, or fail with an HTTP status. */
export interface Control {
  variant: Variant;
  fail?: { status: number; retryAfter?: string } | undefined;
}

/**
 * Groq answers every chat request with `answerFor(mode, selected text, variant)`, or fails as the
 * control says. Returns the calls it saw (this override sits in front of the shared fake, whose
 * own counters therefore stay empty).
 */
export async function tagAnswers(
  context: BrowserContext,
  control: Control = { variant: 'normal' },
): Promise<ChatCall[]> {
  const calls: ChatCall[] = [];
  await overrideChat(context, async (route, mode, word) => {
    calls.push({ mode, word });
    if (control.fail !== undefined) {
      await route.fulfill({
        status: control.fail.status,
        contentType: 'application/json',
        headers:
          control.fail.retryAfter === undefined ? {} : { 'retry-after': control.fail.retryAfter },
        body: JSON.stringify({ error: { message: 'fake failure', type: 'fake_error' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chatBody(JSON.stringify(answerFor(mode, word, control.variant))),
    });
  });
  return calls;
}
