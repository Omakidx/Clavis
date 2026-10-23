import type { Frame, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { CARD, cardOf, type CardProbe } from '../p5-card-support/harness';
import { openFixtureReady, openReader } from '../p7-reader-support/helpers';
import { selectWordByDoubleClick } from '../p7-reader-support/select';
import { dblclickText } from '../spike-b-support/page';
import { tb } from '../spike-b-support/toolbar';
import { openWebpage, type World } from './world';

export type SurfaceName = 'webpage' | 'practice' | 'reader';
export const SURFACES: readonly SurfaceName[] = ['webpage', 'practice', 'reader'];

/**
 * One place a person can select text and press Explain: a web page (content script), the bundled
 * practice page (an extension page hosting the same toolbar and card) or the PDF reader.
 */
export interface Surface {
  name: SurfaceName;
  page: Page;
  /** The document that holds the selection (the practice page's article frame, else the page). */
  target: Page | Frame;
  /** The word `select()` selects. */
  word: string;
  select(): Promise<void>;
  /** Select the word, press Explain with the real mouse and wait for the card. */
  explain(): Promise<CardProbe>;
  dispose(): Promise<void>;
}

export async function openSurface(world: World, name: SurfaceName): Promise<Surface> {
  if (name === 'webpage') {
    const { page, dispose } = await openWebpage(world);
    return build(
      'webpage',
      page,
      page,
      'cartographer',
      () => dblclickText(page, page, 'cartographer'),
      dispose,
    );
  }
  if (name === 'practice') {
    const page = await world.ext.context.newPage();
    await page.goto(`chrome-extension://${world.ext.extensionId}/practice.html`);
    await expect.poll(() => page.frames().some((f) => f.url() === 'about:srcdoc')).toBe(true);
    const frame = page.frames().find((f) => f.url() === 'about:srcdoc') as Frame;
    await frame.waitForSelector('article p');
    return build(
      'practice',
      page,
      frame,
      'river',
      () => dblclickText(page, frame, 'river'),
      () => page.close(),
    );
  }
  const { page } = await openReader(world.ext.context, world.ext.extensionId);
  await openFixtureReady(page, 'text-1page.pdf');
  return build(
    'reader',
    page,
    page,
    'quick',
    () => selectWordByDoubleClick(page, 'quick'),
    () => page.close(),
  );
}

function build(
  name: SurfaceName,
  page: Page,
  target: Page | Frame,
  word: string,
  select: () => Promise<void>,
  dispose: () => Promise<void>,
): Surface {
  return {
    name,
    page,
    target,
    word,
    select,
    async explain() {
      await page.bringToFront();
      await select();
      await tb(target).waitShown();
      await tb(target).click('explain');
      const card = cardOf(page, target);
      await card.waitFor(CARD.card);
      return card;
    },
    dispose,
  };
}
