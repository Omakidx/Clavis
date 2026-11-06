import { expect, test, type Page } from '@playwright/test';
import {
  findControls,
  pageSignature,
  watchEvents,
  type Control,
} from './p8-accept-support/controls';
import { ALL_STATES, type PageState } from './p8-accept-support/states';
import { startWorld, type World } from './p8-accept-support/world';

// Phase 8, "Remove all placeholder controls that do nothing in final ZIP" (gate: "optional
// features are finished or removed"). Every visible, enabled control on every extension page, in
// every state a person can reach (all eight onboarding steps, popup in three situations, Settings
// with and without a key, practice page, reader, side panel) is pressed in the production build;
// after the press something must have changed: the page, its address, the focus, the scroll
// position, a new tab, a file chooser, the clipboard. A control that leaves everything as it was
// is reported with its screen and label.
//
// Controls whose purpose is to leave the page unchanged on purpose are listed in NO_VISIBLE_EFFECT
// with the reason (the page and zoom boundaries of a one-page document).
test.describe.configure({ mode: 'parallel', timeout: 300_000 });

/** `${state} :: ${control label}` -> why pressing it may legitimately change nothing. */
const NO_VISIBLE_EFFECT: Record<string, string> = {
  'reader, a PDF open :: Previous page': 'one-page document: there is no other page (boundary)',
  'reader, a PDF open :: Next page': 'one-page document: there is no other page (boundary)',
  'reader, a PDF open :: Fit width': 'a new document already opens fit to width',
  'onboarding step 5 :: Recommended by Clavis (default)':
    'setup skipped the key, so only the recommended model is available until a key is connected',
  'Settings, no key :: Recommended by Clavis (default)':
    'without a key the model list is empty, so the recommended model is the only choice; the text beside it says to connect a key (observation O-3 in docs/decisions/p8-acceptance.md)',
};

async function quiet(page: Page): Promise<void> {
  // Wait until the page stopped changing by itself (voices loading, status checks).
  let last = await pageSignature(page);
  let since = Date.now();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const now = await pageSignature(page);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= 600) return;
  }
}

/** Bring the control into view first: the scroll it causes is the test's doing, not the control's. */
async function reveal(page: Page, control: Control): Promise<void> {
  await page
    .locator(`[data-sweep-index="${control.index}"]`)
    .scrollIntoViewIfNeeded({ timeout: 3000 });
}

async function press(page: Page, control: Control): Promise<void> {
  const el = page.locator(`[data-sweep-index="${control.index}"]`);
  if (control.kind === 'select') {
    const choice = await el.evaluate((node) => {
      const select = node as HTMLSelectElement;
      return Array.from(select.options).find((o) => o.value !== select.value && !o.disabled)?.value;
    });
    if (choice === undefined) throw new Error('select has a single option');
    await el.selectOption(choice);
  } else {
    await el.click({ timeout: 3000, noWaitAfter: true });
  }
}

async function closeExtras(world: World, keep: Page[]): Promise<void> {
  for (const p of world.ext.context.pages()) {
    if (!keep.includes(p)) await p.close().catch(() => undefined);
  }
}

async function sweepState(world: World, state: PageState): Promise<string[]> {
  // One page stays open for the whole run, so closing the others can never close the window.
  const holder = await world.ext.context.newPage();
  await world.ext.context.route(
    /^https:\/\/(console\.groq\.com|groq\.com|omakidx\.github\.io|example\.com)\//,
    (route) => route.abort('blockedbyclient'),
  );
  const dead: string[] = [];
  let page = await state.open(world);
  await quiet(page);
  const controls = await findControls(page);
  // The only screen with nothing to press is the empty side panel (it says what to do elsewhere).
  if (state.name !== 'side panel, nothing held') {
    expect(controls.length, `${state.name}: controls found`).toBeGreaterThan(0);
  }
  const keepers = (): Page[] => [page, holder];

  for (const control of controls) {
    if (control.inactive) continue;
    await closeExtras(world, keepers());
    const watch = watchEvents(world.ext.context, page);
    const pagesBefore = world.ext.context.pages().length;
    let note = '';
    try {
      await reveal(page, control);
    } catch (error) {
      note = ` (could not be reached: ${String(error).split('\n')[0]})`;
    }
    await holder.waitForTimeout(100);
    const before = await pageSignature(page);
    try {
      await press(page, control);
    } catch (error) {
      note = ` (could not be pressed: ${String(error).split('\n')[0]})`;
    }
    await holder.waitForTimeout(700);
    const after = await pageSignature(page);
    const changed =
      after !== before ||
      watch.count() > 0 ||
      world.ext.context.pages().length !== pagesBefore ||
      page.isClosed();
    watch.dispose();
    if (!changed && NO_VISIBLE_EFFECT[`${state.name} :: ${control.label}`] === undefined) {
      dead.push(`${state.name} :: "${control.label}" (${control.tag})${note}`);
    }
    // Something changed (or the page went): start the next control from the state again.
    if (changed) {
      await closeExtras(world, [holder]);
      page = await state.open(world);
      await quiet(page);
      // The same controls, in the same order: re-number them.
      await findControls(page);
    }
  }
  return dead;
}

for (const state of ALL_STATES) {
  test(`no dead control: ${state.name}`, async () => {
    const world = await startWorld({ granted: false });
    try {
      await world.onboarding.close();
      expect(await sweepState(world, state)).toEqual([]);
    } finally {
      await world.close();
    }
  });
}

// The sweep itself must be able to fail: a button that does nothing is found, a working one is not.
test('self-check: the sweep reports a button that does nothing and accepts one that works', async () => {
  const world = await startWorld({ granted: false });
  try {
    await world.onboarding.close();
    const dead = await sweepState(world, {
      name: 'synthetic',
      open: async (w) => {
        const page = await w.ext.context.newPage();
        await page.goto(`chrome-extension://${w.ext.extensionId}/practice.html`);
        await page.evaluate(() => {
          const inert = document.createElement('button');
          inert.textContent = 'Do nothing';
          const live = document.createElement('button');
          live.textContent = 'Do something';
          live.addEventListener('click', () => live.setAttribute('data-clicked', 'yes'));
          document.body.append(inert, live);
        });
        return page;
      },
    });
    expect(dead.map((d) => d.replace(/ \(button\).*/, ''))).toEqual(['synthetic :: "Do nothing"']);
  } finally {
    await world.close();
  }
});
