import { expect, test, type Frame, type Page } from '@playwright/test';
import { CARD, cardOf } from './p5-card-support/harness';
import { dragSelectSpan } from './p7-reader-support/helpers';
import { dragSelect } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { tagAnswers, type ChatCall } from './p8-accept-support/answers';
import { setUpKey } from './p8-accept-support/setup';
import { openSurface } from './p8-accept-support/surfaces';
import { openWebpage, startWorld, type World } from './p8-accept-support/world';

// Phase 8, "refine word/phrase/sentence-aware action sets" (FR-011, FR-033..FR-035, UJ-02, UJ-03),
// in the PRODUCTION build. Expectations come from the specification, not from the code:
//
//   docs/execution-phases.md Phase 8: "Roots and Related words for words and phrases; Simplify for
//   phrases, sentences and passages". UJ-03: a sentence shows "no irrelevant word-only tabs".
//   Grammar and Translate are flagged off until a live evaluation (see p8-accept-flags.spec.ts).
//
// => word: Core, Roots, Related words | phrase: Core, Roots, Related words, Simplify
//    sentence: Core, Simplify         | passage: Core, Simplify
//
// (requirements.md FR-035 says Simplify is for "sentences and passages" and does not mention
// phrases: a documentation difference, reported in docs/decisions/p8-acceptance.md.)
test.describe.configure({ mode: 'serial', timeout: 90_000 });

let world: World;
let calls: ChatCall[];

test.beforeAll(async () => {
  world = await startWorld({ granted: true });
  calls = await tagAnswers(world.ext.context);
  await setUpKey(world);
});
test.afterAll(async () => {
  await world?.close();
});

const TABS = {
  word: ['Core', 'Roots', 'Related words'],
  phrase: ['Core', 'Roots', 'Related words', 'Simplify'],
  sentence: ['Core', 'Simplify'],
  passage: ['Core', 'Simplify'],
} as const;
const KIND_LABEL = { word: 'Word', phrase: 'Phrase', sentence: 'Sentence', passage: 'Passage' };

/** Selections in tests/fixtures/web/article.html (first paragraph). */
const ARTICLE = {
  word: ['cartographer', 'cartographer'],
  phrase: ['old bank', 'beside'], // "old bank stood beside": four words, no sentence end
  sentence: ['The old bank stood', 'two hundred years.'],
  passage: ['The old bank stood', 'quiet affection.'], // two sentences
} as const;

for (const kind of ['word', 'phrase', 'sentence', 'passage'] as const) {
  test(`webpage, ${kind}: the card offers ${TABS[kind].join(', ')}`, async () => {
    const { page, dispose } = await openWebpage(world, `article.html?scope=${kind}`);
    try {
      await page.bringToFront();
      const [from, to] = ARTICLE[kind];
      await dragSelect(page, page, from, to);
      await tb(page).waitShown();
      // Listen and Explain are the primary actions whatever the scope (FR-013).
      expect(await tb(page).isShown('[data-action="listen"]')).toBe(true);
      expect(await tb(page).isShown('[data-action="explain"]')).toBe(true);
      calls.length = 0;
      await tb(page).click('explain');
      const card = cardOf(page);
      await card.waitFor(CARD.ready('core'));
      expect(await card.text('[data-clavis="card"] .ec__kind')).toBe(KIND_LABEL[kind]);
      expect((await card.tabs())?.map((t) => t.label)).toEqual([...TABS[kind]]);
      // One request for Explain; each tab asks only when it is opened (D-05, FR-038).
      expect(calls.map((c) => c.mode)).toEqual(['core']);
      const lazy = TABS[kind][1];
      const mode = { Roots: 'etymology', 'Related words': 'related_words', Simplify: 'simplify' }[
        lazy
      ] as string;
      await card.click(CARD.tab(mode));
      await card.waitFor(CARD.ready(mode));
      expect(calls.map((c) => c.mode)).toEqual(['core', mode]);
      await card.click(CARD.tab('core'));
      await card.click(CARD.tab(mode));
      await page.waitForTimeout(250);
      expect(calls).toHaveLength(2);
    } finally {
      await dispose();
    }
  });
}

async function selectOn(
  name: 'practice' | 'reader',
  kind: 'word' | 'sentence',
): Promise<{ page: Page; target: Page | Frame; dispose(): Promise<void> }> {
  const surface = await openSurface(world, name);
  await surface.page.bringToFront();
  if (kind === 'word') {
    await surface.select();
  } else if (name === 'practice') {
    await dragSelect(surface.page, surface.target, 'She finally', 'broke the ice.');
  } else {
    await dragSelectSpan(surface.page, 'The quick brown fox jumps over the lazy dog.');
  }
  return surface;
}

for (const name of ['practice', 'reader'] as const) {
  for (const kind of ['word', 'sentence'] as const) {
    test(`${name}, ${kind}: the same tab set as on a web page`, async () => {
      const surface = await selectOn(name, kind);
      try {
        await tb(surface.target).waitShown();
        await tb(surface.target).click('explain');
        const card = cardOf(surface.page, surface.target);
        await card.waitFor(CARD.ready('core'));
        expect(await card.text('[data-clavis="card"] .ec__kind')).toBe(KIND_LABEL[kind]);
        expect((await card.tabs())?.map((t) => t.label)).toEqual([...TABS[kind]]);
      } finally {
        await surface.dispose();
      }
    });
  }
}
