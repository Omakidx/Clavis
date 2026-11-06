import { expect, test, type Page } from '@playwright/test';
import {
  axeOnToolbar,
  expectHidden,
  expectShown,
  observerRunsIn,
  openViaCommand,
  resetPage,
  selectText,
} from './p4-matrix-support/actions';
import { captureMatches, waitFor } from './p4-matrix-support/detect';
import {
  openFixture,
  openPath,
  startHarness,
  type Harness,
  type OpenedFixture,
} from './p4-matrix-support/harness';
import { manifest, normalize, type Fixture } from './p4-matrix-support/manifest';
import {
  hostShown,
  locate,
  nearProblems,
  overlaps,
  readSelection,
  watchHides,
  type Box,
  type Surface,
} from './p4-matrix-support/page';
import {
  buttonNames,
  clickAction,
  readCardText,
  readListenStatus,
  actionSelector,
  readKind,
  readMode,
  rootText,
  SEL,
  toolbar,
  toolbarBox,
} from './p4-matrix-support/toolbar';

// FR-010 .. FR-016 acceptance tests for the webpage selection toolbar, black box: real mouse and
// keyboard input through Playwright, toolbar read only through the DevTools-protocol helper.
// Site access is stood in as granted by the test manifest copy (the permission prompt cannot be
// clicked); everything downstream is the real code.

let harness: Harness;
test.beforeAll(async () => {
  harness = await startHarness();
});
test.afterAll(async () => {
  await harness?.close();
});

const fixtureById = (id: string): Fixture => {
  const fixture = manifest.fixtures.find((f) => f.id === id);
  if (fixture === undefined) throw new Error(`no fixture ${id}`);
  return fixture;
};

async function withFixture<T>(id: string, body: (o: OpenedFixture) => Promise<T>): Promise<T> {
  const opened = await openFixture(harness.ext.context, harness.server, fixtureById(id));
  try {
    return await body(opened);
  } finally {
    await opened.close();
  }
}

async function withPath<T>(
  file: string,
  body: (o: OpenedFixture) => Promise<T>,
  options: { viewport?: { width: number; height: number } } = {},
): Promise<T> {
  const opened = await openPath(harness.ext.context, harness.server, file, undefined, options);
  try {
    return await body(opened);
  } finally {
    await opened.close();
  }
}

const viewportOf = (surface: Surface): Promise<{ width: number; height: number }> =>
  surface.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));

/** Assert the toolbar is near the selection, inside the viewport and not on top of the text. */
async function expectWellPlaced(surface: Surface, label: string): Promise<void> {
  const [box, selection, viewport] = await Promise.all([
    toolbarBox(surface),
    readSelection(surface),
    viewportOf(surface),
  ]);
  expect(selection.bounds, `${label}: there is a selection`).not.toBeNull();
  const problems = nearProblems(box, selection.bounds as Box, viewport);
  expect(problems, `${label}: toolbar placement ${JSON.stringify(box)}`).toEqual([]);
  expect(
    selection.rects.some((rect) => overlaps(box, rect)),
    `${label}: toolbar must not cover the selected text`,
  ).toBe(false);
}

// --------------------------------------------------------------------------------------------
test.describe('FR-010 detect non-empty selections in regular HTTP(S) text', () => {
  test('mouse: double-click, drag and triple-click each raise the toolbar', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page), 'double-click').toBe(true);
      await resetPage(page);
      await selectText(
        page,
        page,
        { context: 'finally broke the ice by', text: 'broke the ice' },
        'drag',
      );
      expect(await expectShown(page), 'drag').toBe(true);
      await resetPage(page);
      await selectText(
        page,
        page,
        { paragraph: '#pb-2', startsWith: 'A notebook is a patient' },
        'triple',
      );
      expect(await expectShown(page), 'triple-click').toBe(true);
    });
  });

  test('keyboard: growing a selection with Shift+Arrow updates the toolbar to the new text', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      const { start } = await selectText(
        page,
        page,
        { context: 'finally broke the ice by', text: 'broke' },
        'dblclick',
      );
      expect(start.x).toBeGreaterThan(0);
      expect(await expectShown(page)).toBe(true);
      await page.keyboard.down('Shift');
      for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
      await page.keyboard.up('Shift');
      expect(await selectedText(page)).toBe('broke the ice');
      // The toolbar now reports the grown selection: kind phrase and the captured text.
      await waitFor(async () => (await readKind(page)) === 'phrase', 1500, 40);
      expect(await readKind(page)).toBe('phrase');
      await clickAction(page, 'explain');
      expect(await readCardText(page)).toBe('broke the ice');
    });
  });

  test('keyboard: Ctrl+A raises the toolbar for the page text', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await page.mouse.click(5, 5);
      await page.keyboard.press('Control+a');
      expect(await expectShown(page)).toBe(true);
      expect(await readKind(page)).toBe('passage');
    });
  });

  test('a collapsed selection (a plain click) shows nothing', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await page.mouse.click(400, 300);
      await page.mouse.click(420, 320);
      await page.waitForTimeout(400);
      expect(await hostShown(page)).toBe(false);
      await toolbar(page).expectNoHost();
    });
  });

  test('selection constraints: inputs, passwords, textareas and editable regions are skipped; ordinary text beside them is not', async () => {
    await withPath('editable-fields.html', async ({ page }) => {
      for (const id of ['#ef-text', '#ef-pass', '#ef-area', '#editable']) {
        await page.locator(id).dblclick();
        await page.waitForTimeout(350);
        expect(await hostShown(page), `${id} must not raise the toolbar`).toBe(false);
        await page.mouse.click(600, 500);
      }
      await toolbar(page).expectNoHost();
      await selectText(
        page,
        page,
        { context: 'Ordinary paragraph text', text: 'paragraph' },
        'dblclick',
      );
      expect(await expectShown(page), 'ordinary text still works').toBe(true);
    });
  });

  test('selection constraints: a selection that spans fields never captures field values, editable text or hidden text', async () => {
    await withPath('editable-fields.html', async ({ page }) => {
      const forbidden = [
        'hunter2',
        'secret input value',
        'textarea content',
        'draft words',
        'display none hidden',
        'visibility hidden',
      ];
      // Select-all, and a real drag from the ordinary paragraph through the editable region.
      for (const how of ['select-all', 'drag through the fields'] as const) {
        await resetPage(page);
        if (how === 'select-all') {
          await page.mouse.click(600, 500);
          await page.keyboard.press('Control+a');
        } else {
          const start = await locate(page, {
            context: 'Ordinary paragraph text',
            text: 'Ordinary',
          });
          const end = await locate(page, {
            context: 'editable region with draft words',
            text: 'words',
          });
          await page.mouse.move(start.start.x, start.start.y);
          await page.mouse.down();
          await page.mouse.move(end.end.x, end.end.y, { steps: 8 });
          await page.mouse.up();
        }
        await page.waitForTimeout(500);
        // Either no toolbar (the selection touches an editable region) or a toolbar whose
        // captured text is free of everything that must not be collected.
        if (await hostShown(page)) {
          await clickAction(page, 'explain');
          const captured = (await readCardText(page)) ?? '';
          for (const word of forbidden) {
            expect(captured, `${how}: "${word}" must not be captured`).not.toContain(word);
          }
        }
      }
    });
  });

  test('non-HTTP(S) documents are not eligible (data: URL)', async () => {
    const page = await harness.ext.context.newPage();
    try {
      await page.goto('data:text/html,<p style="font:24px sans-serif">hello eligible world</p>');
      expect(await observerRunsIn(page, 800)).toBe(false);
      await page.mouse.dblclick(30, 28);
      await page.waitForTimeout(400);
      await toolbar(page).expectNoHost();
    } finally {
      await page.close();
    }
  });
});

async function selectedText(surface: Surface): Promise<string> {
  return normalize((await readSelection(surface)).text);
}

// --------------------------------------------------------------------------------------------
test.describe('FR-011 word / phrase / sentence / passage classification and normalisation', () => {
  const rows: Array<{
    name: string;
    text: string;
    context: string;
    method: 'dblclick' | 'drag';
    kind: string;
  }> = [
    {
      name: 'a single word',
      text: 'bank',
      context: 'sat on the bank of the river',
      method: 'dblclick',
      kind: 'word',
    },
    {
      name: 'a word with trailing punctuation',
      text: 'faded.',
      context: 'until the light faded. Nobody',
      method: 'drag',
      kind: 'word',
    },
    {
      name: 'a short phrase',
      text: 'broke the ice',
      context: 'finally broke the ice by',
      method: 'drag',
      kind: 'phrase',
    },
    {
      name: 'a multi-word technical phrase',
      text: 'half finished thought',
      context: 'the half finished thought you',
      method: 'drag',
      kind: 'phrase',
    },
    {
      name: 'one complete sentence',
      text: 'She finally broke the ice by reading aloud a single line, and the room relaxed immediately.',
      context:
        'She finally broke the ice by reading aloud a single line, and the room relaxed immediately.',
      method: 'drag',
      kind: 'sentence',
    },
    {
      name: 'two sentences',
      text: 'A notebook is a patient listener. It does not interrupt, it does not judge, and it never forgets the half finished thought you abandoned on Tuesday.',
      context:
        'A notebook is a patient listener. It does not interrupt, it does not judge, and it never forgets the half finished thought you abandoned on Tuesday.',
      method: 'drag',
      kind: 'passage',
    },
  ];
  for (const row of rows) {
    test(`${row.name} is classified as ${row.kind}`, async () => {
      await withFixture('plain-baseline', async ({ page }) => {
        await selectText(page, page, { context: row.context, text: row.text }, row.method);
        expect(await expectShown(page)).toBe(true);
        expect(await readKind(page)).toBe(row.kind);
      });
    });
  }

  test('a very long selection (over the limit) is a passage', async () => {
    await withFixture('long-passage', async ({ page }) => {
      await selectText(
        page,
        page,
        {
          paragraph: '#lp-long',
          startsWith: fixtureById('long-passage').targets[1]?.startsWith ?? '',
        },
        'triple',
      );
      expect(await expectShown(page)).toBe(true);
      expect(await readKind(page)).toBe('passage');
    });
  });

  test('whitespace and invisible characters are normalised: NBSP, soft hyphen and runs of spaces never reach the captured text', async () => {
    await withFixture('inline-nested-punctuation', async ({ page }) => {
      const target = fixtureById('inline-nested-punctuation').targets.find((t) => t.id === 's2');
      const expected = target?.text ?? '';
      await selectText(page, page, { context: target?.context ?? '', text: expected }, 'drag');
      expect(await expectShown(page)).toBe(true);
      await clickAction(page, 'explain');
      const captured = await readCardText(page);
      expect(captured, 'the card exposes the captured text').toBeDefined();
      expect(captured).toBe(expected);
      expect(captured).not.toMatch(/[\u00a0\u00ad\u200b\ufeff]/);
      expect(captured).not.toMatch(/\s{2,}|\n/);
    });
  });

  test('a multi-line paragraph is captured as one line of single-spaced text', async () => {
    await withFixture('news-article', async ({ page }) => {
      await selectText(
        page,
        page,
        { paragraph: '#lead', startsWith: 'The island ferry will resume' },
        'triple',
      );
      expect(await expectShown(page)).toBe(true);
      await clickAction(page, 'explain');
      const captured = (await readCardText(page)) ?? '';
      expect(captured.length).toBeGreaterThan(50);
      expect(captured).not.toMatch(/\n|\s{2,}/);
      expect(captured.startsWith('The island ferry will resume its full timetable')).toBe(true);
    });
  });

  test('selected text keeps its Unicode: RTL, CJK and accented characters are captured unchanged', async () => {
    for (const [id, targetId] of [
      ['rtl-arabic', 's1'],
      ['rtl-hebrew', 's1'],
      ['cjk-latin-mixed', 's1'],
    ] as const) {
      await withFixture(id, async (o) => {
        const target = fixtureById(id).targets.find((t) => t.id === targetId);
        await selectText(
          o.page,
          o.page,
          { context: target?.context ?? target?.text ?? '', text: target?.text ?? '' },
          'drag',
          id.startsWith('rtl') ? 'ArrowLeft' : 'ArrowRight',
        );
        expect(await expectShown(o.page), id).toBe(true);
        await clickAction(o.page, 'explain');
        const captured = (await readCardText(o.page)) ?? '';
        expect(captureMatches(captured, normalize(target?.text ?? '')), `${id}: ${captured}`).toBe(
          true,
        );
      });
    }
  });
});

// --------------------------------------------------------------------------------------------
test.describe('FR-012 compact toolbar near the selection without blocking content', () => {
  const layouts: Array<[string, string, string, string]> = [
    ['plain-baseline', 'finally broke the ice by', 'broke the ice', 'plain article'],
    ['news-article', 'resume its full timetable on', 'full timetable', 'article with sidebar'],
    ['multicolumn', 'without airport queues or', 'airport queues', 'CSS columns'],
    [
      'sticky-share-bar',
      'a retired teacher produced',
      'retired teacher',
      'sticky header and share bar',
    ],
    [
      'dense-fixed-header',
      'only reliable coordinate space',
      'reliable coordinate space',
      'three stacked fixed bars',
    ],
    [
      'transformed-zoom',
      'every client rectangle without',
      'client rectangle',
      'zoom, scale and rotate',
    ],
    ['dark-mode', 'A thin red lamp guides', 'thin red lamp', 'dark theme'],
    ['grid-magazine', 'Window seats, flasks of coffee and', 'flasks of coffee', 'CSS grid'],
  ];
  for (const [id, context, text, label] of layouts) {
    test(`near the selection, inside the viewport and not covering the text: ${label}`, async () => {
      await withFixture(id, async ({ page }) => {
        await selectText(page, page, { context, text }, 'drag');
        expect(await expectShown(page)).toBe(true);
        await expectWellPlaced(page, id);
      });
    });
  }

  test('right-to-left text (Arabic and Hebrew) is well placed', async () => {
    for (const [id, context, text] of [
      ['rtl-arabic', 'في وسط المدينة،', 'وسط المدينة'],
      ['rtl-hebrew', 'מסדרים את הפירות על הדוכנים', 'הפירות על הדוכנים'],
    ] as const) {
      await withFixture(id, async ({ page }) => {
        await selectText(page, page, { context, text }, 'drag', 'ArrowLeft');
        expect(await expectShown(page), id).toBe(true);
        await expectWellPlaced(page, id);
      });
    }
  });

  // FR-012 "without blocking content" for vertical writing (writing-mode: vertical-rl): the toolbar
  // is placed above the first rect / below the last as for horizontal text, which lands on top of
  // the neighbouring columns. Found by the matrix as defect D-1 and fixed in Phase 4; now a
  // regression test.
  test('vertical writing: the toolbar does not cover the selected text', async () => {
    await withFixture('vertical-writing', async ({ page }) => {
      const target = fixtureById('vertical-writing').targets.find((t) => t.id === 's2');
      await selectText(
        page,
        page,
        { context: target?.text ?? '', text: target?.text ?? '' },
        'drag',
        'ArrowDown',
      );
      expect(await expectShown(page)).toBe(true);
      await expectWellPlaced(page, 'vertical-rl');
    });
  });

  test('viewport corners and the right edge: the toolbar is never clipped and stays next to the word', async () => {
    await withPath('placement-corners.html', async ({ page }) => {
      for (const word of ['alphaone', 'bravotwo', 'charliethree', 'deltafour']) {
        await selectText(page, page, { context: word, text: word }, 'dblclick');
        expect(await expectShown(page), word).toBe(true);
        await expectWellPlaced(page, word);
        await resetPage(page);
      }
      await page.evaluate(() => window.scrollTo(0, 1300));
      await selectText(page, page, { context: 'echofive', text: 'echofive' }, 'dblclick');
      expect(await expectShown(page), 'echofive at the right edge').toBe(true);
      await expectWellPlaced(page, 'echofive');
    });
  });

  test('a selection taller than the viewport still gets an on-screen toolbar', async () => {
    await withPath('placement-corners.html', async ({ page }) => {
      await page.mouse.move(640, 300);
      for (const clickCount of [1, 2, 3]) {
        await page.mouse.down({ clickCount });
        await page.mouse.up({ clickCount });
      }
      expect(await expectShown(page)).toBe(true);
      const selection = await readSelection(page);
      expect(
        selection.bounds?.height ?? 0,
        'the selection is taller than the viewport',
      ).toBeGreaterThan((await viewportOf(page)).height);
      const [box, viewport] = await Promise.all([toolbarBox(page), viewportOf(page)]);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
    });
  });

  test('scrolling: the toolbar follows its selection, and never strands on screen when the selection leaves', async () => {
    await withFixture('very-long', async ({ page }) => {
      await selectText(
        page,
        page,
        {
          context:
            'First stretch: The valley road follows the river for most of its length, and travellers rarely',
          text: 'valley road follows the river',
        },
        'drag',
      );
      expect(await expectShown(page)).toBe(true);
      const before = await toolbarBox(page);
      await page.mouse.wheel(0, 60);
      await waitFor(async () => (await page.evaluate(() => scrollY)) >= 55, 3000, 40);
      await page.waitForTimeout(300);
      const after = await toolbarBox(page);
      expect(
        Math.round(before.y - after.y),
        'moved up with the text by the scroll distance',
      ).toBeGreaterThanOrEqual(50);
      await expectWellPlaced(page, 'after a small scroll');
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(300);
      const selection = await readSelection(page);
      const viewport = await viewportOf(page);
      const selectionVisible =
        selection.bounds !== null &&
        selection.bounds.y + selection.bounds.height > 0 &&
        selection.bounds.y < viewport.height;
      if (selectionVisible) await expectWellPlaced(page, 'after a long scroll');
      else
        expect(
          await toolbar(page).isShown(),
          'a toolbar for a selection that left the viewport is hidden',
        ).toBe(false);
    });
  });

  test('resize: shrinking the window keeps the toolbar inside it and next to the selection', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'finally broke the ice by', text: 'broke the ice' },
        'drag',
      );
      expect(await expectShown(page)).toBe(true);
      for (const size of [
        { width: 700, height: 500 },
        { width: 420, height: 500 },
      ]) {
        await page.setViewportSize(size);
        await page.waitForTimeout(350);
        const selection = await readSelection(page);
        const viewport = await viewportOf(page);
        const visible =
          selection.bounds !== null &&
          selection.bounds.y + selection.bounds.height > 0 &&
          selection.bounds.y < viewport.height &&
          selection.bounds.x < viewport.width;
        if (visible) await expectWellPlaced(page, `${size.width}px wide`);
      }
    });
  });

  test('320 px wide viewport: the toolbar fits and stays next to the selection', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.waitForTimeout(200);
      await selectText(
        page,
        page,
        { context: 'finally broke the ice by', text: 'broke the ice' },
        'drag',
      );
      expect(await expectShown(page)).toBe(true);
      await expectWellPlaced(page, '320px');
      expect((await toolbarBox(page)).width).toBeLessThanOrEqual(320);
    });
  });

  test('200% and 400% zoom (equivalent CSS viewports 640x360 and 320x180): the toolbar fits', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      for (const size of [
        { width: 640, height: 360 },
        { width: 320, height: 180 },
      ]) {
        await page.setViewportSize(size);
        await page.waitForTimeout(200);
        await resetPage(page);
        await selectText(
          page,
          page,
          { context: 'finally broke the ice by', text: 'broke the ice' },
          'drag',
        );
        expect(await expectShown(page), `${size.width}x${size.height}`).toBe(true);
        const [box, viewport] = await Promise.all([toolbarBox(page), viewportOf(page)]);
        expect(box.x, `${size.width}: left`).toBeGreaterThanOrEqual(0);
        expect(box.y, `${size.width}: top`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${size.width}: right`).toBeLessThanOrEqual(viewport.width + 0.5);
        expect(box.y + box.height, `${size.width}: bottom`).toBeLessThanOrEqual(
          viewport.height + 0.5,
        );
      }
    });
  });

  test('pinch zoom (visual viewport scale 2): the toolbar is inside the visible area', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      const cdp = await harness.ext.context.newCDPSession(page);
      try {
        await selectText(
          page,
          page,
          { context: 'finally broke the ice by', text: 'broke the ice' },
          'drag',
        );
        expect(await expectShown(page)).toBe(true);
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
        await page.waitForTimeout(400);
        const visual = await page.evaluate(() => ({
          left: visualViewport?.offsetLeft ?? 0,
          top: visualViewport?.offsetTop ?? 0,
          width: visualViewport?.width ?? 0,
          height: visualViewport?.height ?? 0,
          scale: visualViewport?.scale ?? 1,
        }));
        expect(visual.scale).toBeCloseTo(2, 1);
        const selection = await readSelection(page);
        const sel = selection.bounds;
        const selectionInView =
          sel !== null &&
          sel.x + sel.width > visual.left &&
          sel.x < visual.left + visual.width &&
          sel.y + sel.height > visual.top &&
          sel.y < visual.top + visual.height;
        if (!selectionInView) {
          expect(
            await toolbar(page).isShown(),
            'toolbar for an off-screen selection is hidden',
          ).toBe(false);
          return;
        }
        const box = await toolbarBox(page);
        expect(box.x).toBeGreaterThanOrEqual(visual.left - 0.5);
        expect(box.y).toBeGreaterThanOrEqual(visual.top - 0.5);
        expect(box.x + box.width).toBeLessThanOrEqual(visual.left + visual.width + 0.5);
        expect(box.y + box.height).toBeLessThanOrEqual(visual.top + visual.height + 0.5);
      } finally {
        await cdp
          .send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
          .catch(() => undefined);
        await cdp.detach().catch(() => undefined);
      }
    });
  });

  test('a modal <dialog>: the toolbar is shown and clickable above the inert page', async () => {
    await withFixture('dialog-modal', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'volume with gentle care', text: 'gentle' },
        'dblclick',
      );
      expect(await expectShown(page), 'toolbar inside the dialog').toBe(true);
      await clickAction(page, 'explain');
      expect(
        await readCardText(page),
        'a click reaches the toolbar (the dialog makes outside content inert)',
      ).toBe('gentle');
    });
  });

  test('page inside a same-origin iframe: toolbar appears in the frame next to the word', async () => {
    await withFixture('iframe-same-origin', async (o) => {
      const frame = o.surface('inner');
      await selectText(
        o.page,
        frame,
        { context: 'raise the toolbar in this frame', text: 'toolbar' },
        'dblclick',
      );
      expect(await expectShown(frame)).toBe(true);
      await expectWellPlaced(frame, 'iframe');
    });
  });
});

// --------------------------------------------------------------------------------------------
test.describe('FR-010 / FR-012 further layouts and gestures', () => {
  test('a backwards drag (end to start) and Shift+click both raise the toolbar for the right text', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      const located = await locate(page, {
        context: 'finally broke the ice by',
        text: 'broke the ice',
      });
      await page.mouse.move(located.end.x, located.end.y);
      await page.mouse.down();
      await page.mouse.move((located.end.x + located.start.x) / 2, located.start.y, { steps: 4 });
      await page.mouse.move(located.start.x, located.start.y, { steps: 4 });
      await page.mouse.up();
      expect(await expectShown(page), 'backwards drag').toBe(true);
      await clickAction(page, 'explain');
      expect(await readCardText(page)).toBe('broke the ice');

      await resetPage(page);
      const word = await locate(page, { context: 'sat on the bank of the river', text: 'bank' });
      const far = await locate(page, { context: 'until the light faded.', text: 'light' });
      await page.mouse.click(word.start.x, word.start.y);
      await page.keyboard.down('Shift');
      await page.mouse.click(far.end.x, far.end.y);
      await page.keyboard.up('Shift');
      expect(await expectShown(page), 'Shift+click').toBe(true);
      expect(await selectedText(page)).toBe('bank of the river and talked until the light');
      await waitFor(
        async () => (await readKind(page)) === 'phrase' || (await readKind(page)) === 'sentence',
        1000,
        40,
      );
      await clickAction(page, 'explain');
      expect(await readCardText(page)).toBe('bank of the river and talked until the light');
    });
  });

  test('a selection that spans two paragraphs is one passage', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      const a = await locate(page, { context: 'talked until the light faded.', text: 'talked' });
      const b = await locate(page, {
        context: 'A notebook is a patient listener',
        text: 'notebook',
      });
      await page.mouse.move(a.start.x, a.start.y);
      await page.mouse.down();
      await page.mouse.move(b.end.x, b.end.y, { steps: 8 });
      await page.mouse.up();
      expect(await expectShown(page)).toBe(true);
      expect(await readKind(page)).toBe('passage');
    });
  });

  test('rapid successive selections end with the toolbar for the LAST one (no stale toolbar)', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      const words: Array<[string, string]> = [
        ['sat on the bank of the river', 'bank'],
        ['such as idempotent or', 'idempotent'],
        ['finally broke the ice by', 'ice'],
        ['such as idempotent or eigenvalue', 'eigenvalue'],
        ['patient listener', 'listener'],
      ];
      for (const [context, text] of words) {
        const located = await locate(page, { context, text });
        await page.mouse.dblclick(located.center.x, located.center.y, { delay: 30 });
      }
      expect(await expectShown(page)).toBe(true);
      await page.waitForTimeout(300);
      await clickAction(page, 'explain');
      expect(await readCardText(page)).toBe('listener');
    });
  });

  test('selecting text inside the toolbar card does not replace the card or capture the toolbar text', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      await clickAction(page, 'explain');
      expect(await readCardText(page)).toBe('bank');
      const box = await toolbar(page).box(SEL.cardText);
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      for (const clickCount of [1, 2, 3]) {
        await page.mouse.down({ clickCount });
        await page.mouse.up({ clickCount });
      }
      await page.waitForTimeout(500);
      expect(await toolbar(page).isShown(), 'the toolbar is still there').toBe(true);
      expect(await readCardText(page), 'and still describes the page selection').toBe('bank');
    });
  });

  test('cross-origin iframe with site access: the toolbar appears inside the frame next to the word', async () => {
    const opened = await openPath(
      harness.ext.context,
      harness.server,
      'iframe-cross-origin.html',
      undefined,
      {
        noObserver: true,
      },
    );
    try {
      const page = opened.page;
      const frame = await waitForFrame(page, harness.server.crossOrigin);
      let shown = false;
      // The out-of-process frame's content script has no readiness gate: retry like a user would.
      for (let attempt = 0; attempt < 6 && !shown; attempt++) {
        await resetPage(page, frame);
        await selectText(
          page,
          frame,
          { context: 'raise the toolbar in this frame', text: 'toolbar' },
          'dblclick',
        );
        shown = await expectShown(frame, 800);
      }
      expect(shown, 'toolbar in the cross-origin frame').toBe(true);
      await expectWellPlaced(frame, 'cross-origin iframe');
      await toolbar(page).expectNoHost();
    } finally {
      await opened.close();
    }
  });

  test('text in a scrolling container: the toolbar follows the container scroll', async () => {
    await withPath('scroll-container.html', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'Entry two lists the repairs made', text: 'repairs' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      const before = await toolbarBox(page);
      const pane = await page.locator('#scroller').boundingBox();
      await page.mouse.move((pane?.x ?? 0) + 40, (pane?.y ?? 0) + 120);
      await page.mouse.wheel(0, 60);
      await waitFor(
        async () =>
          (await page.evaluate(() => document.getElementById('scroller')?.scrollTop ?? 0)) >= 55,
        3000,
        40,
      );
      await page.waitForTimeout(300);
      const after = await toolbarBox(page);
      expect(
        Math.round(before.y - after.y),
        'moved with the container text',
      ).toBeGreaterThanOrEqual(50);
      await expectWellPlaced(page, 'after scrolling the container');
    });
  });

  test('select-all on a very long page is "Selection too long"', async () => {
    await withFixture('very-long', async ({ page }) => {
      await page.mouse.click(5, 5);
      await page.keyboard.press('Control+a');
      expect(await expectShown(page)).toBe(true);
      expect(await readMode(page)).toBe('too-long');
      expect(await rootText(page)).toMatch(/Selection too long/i);
    });
  });
});

async function waitForFrame(page: Page, origin: string): Promise<Surface> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const frame = page.frames().find((f) => f.url().startsWith(origin));
    if (frame !== undefined) return frame;
    if (Date.now() > deadline) throw new Error(`no frame from ${origin}`);
    await page.waitForTimeout(100);
  }
}

/** Whether keyboard focus is inside the explanation card (the card slot of the closed root). */
async function focusIsInCard(page: Page): Promise<boolean> {
  return (
    (await toolbar(page).evalIn<boolean>(
      null,
      `function () {
        let el = this.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        return !!el && !!el.closest('[data-clavis="card-slot"], [data-clavis="card"]');
      }`,
    )) === true
  );
}

/** Whether the focused element is the card control with this data-clavis name. */
async function focusedCardControl(page: Page, name: string): Promise<boolean> {
  return (
    (await toolbar(page).evalIn<boolean>(
      null,
      `function () {
        let el = this.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        return !!el && el.getAttribute('data-clavis') === ${JSON.stringify(name)};
      }`,
    )) === true
  );
}

// --------------------------------------------------------------------------------------------
test.describe('FR-013 Listen, Slow and Explain, by mouse and by keyboard', () => {
  test('Listen, Slow and Explain are visible together with their names', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      expect(await buttonNames(page)).toEqual(['Lookup', 'Speak', 'Slower speech, 0.75×']);
      for (const action of ['listen', 'slow', 'explain'] as const) {
        expect(await toolbar(page).isShown(actionSelector(action)), action).toBe(true);
      }
      expect(await toolbar(page).attr(actionSelector('slow'), 'aria-pressed')).toBe('false');
    });
  });

  test('mouse: each control can be pressed and acts on the captured selection', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      // Listen opens no card: it reports on its own status line (this machine has no voices).
      await clickAction(page, 'listen');
      const status = await readListenStatus(page);
      expect(status, 'Listen reports its state').toBeDefined();
      expect(['starting', 'playing', 'ended', 'unavailable']).toContain(status?.status);
      expect(
        await toolbar(page).isShown(SEL.card),
        'Listen does not open the explanation card',
      ).toBe(false);
      // Slow is a toggle.
      await clickAction(page, 'slow');
      expect(await toolbar(page).attr(actionSelector('slow'), 'aria-pressed')).toBe('true');
      await clickAction(page, 'slow');
      expect(await toolbar(page).attr(actionSelector('slow'), 'aria-pressed')).toBe('false');
      await clickAction(page, 'explain');
      await waitFor(
        async () => (await toolbar(page).attr(SEL.card, 'data-action')) === 'explain',
        1000,
        40,
      );
      expect(await toolbar(page).attr(SEL.card, 'data-action')).toBe('explain');
      expect(await readCardText(page)).toBe('bank');
    });
  });

  test('keyboard: the command path puts focus on Lookup; arrows reach Speak then speed; Enter and Space activate', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      const reply = await openViaCommand(harness.ext.serviceWorker, page);
      expect(reply?.shown).toBe(true);
      expect(await toolbar(page).focusedAction(), 'focus moved into the toolbar').toBe('explain');
      await page.keyboard.press('ArrowRight');
      expect(await toolbar(page).focusedAction(), 'Lookup, then Speak').toBe('listen');
      await page.keyboard.press('ArrowRight');
      expect(await toolbar(page).focusedAction(), 'then speed').toBe('slow');
      await page.keyboard.press('Space');
      expect(await toolbar(page).attr(actionSelector('slow'), 'aria-pressed')).toBe('true');
      await page.keyboard.press('Space');
      expect(await toolbar(page).attr(actionSelector('slow'), 'aria-pressed')).toBe('false');
      await page.keyboard.press('Home');
      expect(await toolbar(page).focusedAction(), 'back to Lookup').toBe('explain');
      await page.keyboard.press('Enter');
      // Phase 5: a keyboard-started Explain moves focus INTO the card.
      await waitFor(
        async () => (await toolbar(page).attr(SEL.card, 'data-action')) === 'explain',
        3000,
        40,
      );
      expect(await toolbar(page).attr(SEL.card, 'data-action')).toBe('explain');
      expect(await focusIsInCard(page), 'focus moved into the explanation card').toBe(true);
      // Tab to the card's Close button and press it: focus returns to the Explain button.
      for (let i = 0; i < 10 && !(await focusedCardControl(page, 'card-close')); i++) {
        await page.keyboard.press('Tab');
      }
      expect(await focusedCardControl(page, 'card-close'), 'Close is reachable with Tab').toBe(
        true,
      );
      await page.keyboard.press('Enter');
      await waitFor(async () => (await toolbar(page).focusedAction()) === 'explain', 2000, 40);
      expect(await toolbar(page).focusedAction(), 'Close returns focus to Explain').toBe('explain');
      expect(await toolbar(page).isShown(SEL.card), 'the card is gone').toBe(false);
      // The toolbar keyboard model still works: ArrowRight to Speak, Space activates it.
      await page.keyboard.press('ArrowRight');
      expect(await toolbar(page).focusedAction()).toBe('listen');
      await page.keyboard.press('Space');
      expect(await readListenStatus(page), 'Listen reports through the keyboard too').toBeDefined();
      // Escape dismisses everything.
      await page.keyboard.press('Escape');
      expect(await expectHidden(page), 'Escape closes the toolbar and the card').toBe(true);
    });
  });
});

// --------------------------------------------------------------------------------------------
test.describe('FR-014 dismissal, and persistence while the toolbar is used', () => {
  async function shownFor(page: Page): Promise<void> {
    await selectText(
      page,
      page,
      { context: 'sat on the bank of the river', text: 'bank' },
      'dblclick',
    );
    expect(await expectShown(page)).toBe(true);
  }

  test('Escape dismisses it', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await shownFor(page);
      await page.keyboard.press('Escape');
      expect(await expectHidden(page)).toBe(true);
    });
  });

  test('a click outside dismisses it, and it does not come back by itself', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await shownFor(page);
      await page.mouse.click(40, 600);
      expect(await expectHidden(page)).toBe(true);
      await page.waitForTimeout(500);
      expect(await hostShown(page)).toBe(false);
    });
  });

  test('removing the selection (clicking into text) dismisses it', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await shownFor(page);
      await page.mouse.click(500, 420);
      expect(await expectHidden(page)).toBe(true);
    });
  });

  test('removing the selection from script dismisses it', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await shownFor(page);
      await page.evaluate(() => getSelection()?.removeAllRanges());
      expect(await expectHidden(page)).toBe(true);
    });
  });

  test('clicking the toolbar keeps it open without flicker and keeps the captured text', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await shownFor(page);
      const stop = await watchHides(page);
      await clickAction(page, 'explain');
      await page.waitForTimeout(600);
      const hides = await stop();
      expect(hides, 'the toolbar must never hide while it is being used').toBe(0);
      expect(await hostShown(page)).toBe(true);
      expect(await readCardText(page)).toBe('bank');
    });
  });

  test('a page that clears the selection on every press cannot dismiss the toolbar or change what it captured', async () => {
    await withPath('selection-clearing.html', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'Some sites clear the selection whenever', text: 'clear' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      const stop = await watchHides(page);
      await clickAction(page, 'explain');
      await page.waitForTimeout(600);
      expect(await stop(), 'no flicker').toBe(0);
      expect(await hostShown(page)).toBe(true);
      expect(await readCardText(page), 'the snapshot taken at selection end is kept').toBe('clear');
      expect(
        await readSelection(page).then((s) => s.text),
        'the page really cleared its selection',
      ).toBe('');
    });
  });

  test('after Escape, selecting the same word again with the mouse shows the toolbar again', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await shownFor(page);
      await page.keyboard.press('Escape');
      expect(await expectHidden(page)).toBe(true);
      await page.waitForTimeout(300);
      // No reset in between: the user double-clicks the very same (still selected) word again,
      // with a human gap between the two clicks (an instantaneous double-click is a different
      // case, see docs/decisions/p4-acceptance-matrix.md).
      const located = await locate(page, { context: 'sat on the bank of the river', text: 'bank' });
      await page.mouse.dblclick(located.center.x, located.center.y, { delay: 60 });
      expect(await expectShown(page), 're-selecting the same word after Escape').toBe(true);
    });
  });

  test('after the toolbar was used, removing the selection later still dismisses it', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await shownFor(page);
      await clickAction(page, 'explain');
      expect(await readCardText(page)).toBe('bank');
      await page.waitForTimeout(600);
      await page.evaluate(() => getSelection()?.removeAllRanges());
      expect(
        await expectHidden(page, 2500),
        'dismissed by selection removal after the interaction',
      ).toBe(true);
    });
  });

  test('inside a modal dialog: Escape closes the toolbar first, and a click elsewhere in the dialog dismisses it', async () => {
    await withFixture('dialog-modal', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'volume with gentle care', text: 'gentle' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      await page.keyboard.press('Escape');
      expect(await expectHidden(page), 'Escape hides the toolbar').toBe(true);
      expect(
        await page.evaluate(() => document.querySelector('dialog')?.open),
        'and keeps the dialog open',
      ).toBe(true);
      await page.waitForTimeout(300);
      const word = await locate(page, { context: 'volume with gentle care', text: 'gentle' });
      await page.mouse.dblclick(word.center.x, word.center.y, { delay: 60 });
      expect(await expectShown(page)).toBe(true);
      const dialog = await page.locator('dialog').boundingBox();
      await page.mouse.click((dialog?.x ?? 0) + 8, (dialog?.y ?? 0) + 8);
      expect(await expectHidden(page), 'a click on the dialog dismisses it').toBe(true);
    });
  });

  // Known edge, kept as a runnable reproduction: the observer ignores a selection equal to the
  // previous one, and Escape hides the toolbar without forgetting that selection. A real
  // double-click (tens of ms between clicks) collapses the selection first and works (see the test
  // above). Found by the matrix as edge E-1 and fixed in Phase 4; now a regression test.
  test('instantaneous double-click on the still-selected word right after Escape shows the toolbar again', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await shownFor(page);
      await page.keyboard.press('Escape');
      expect(await expectHidden(page)).toBe(true);
      await page.waitForTimeout(300);
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page, 1500)).toBe(true);
    });
  });

  test('a new selection replaces the old toolbar content (no stale card)', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await shownFor(page);
      await clickAction(page, 'explain');
      expect(await readCardText(page)).toBe('bank');
      await resetPage(page);
      await selectText(
        page,
        page,
        { context: 'such as idempotent or', text: 'idempotent' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      expect(await toolbar(page).isShown(SEL.card), 'old card is gone').toBe(false);
      await clickAction(page, 'explain');
      expect(await readCardText(page)).toBe('idempotent');
    });
  });
});

// --------------------------------------------------------------------------------------------
test.describe('FR-016 accessibility: roles, labels, focus, motion, automated checks', () => {
  test('the toolbar is a labelled role=toolbar with native buttons; the card is a status region', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      const info = await toolbar(page).evalIn<{
        role: string | null;
        label: string | null;
        buttons: Array<{ tag: string; type: string | null; name: string }>;
      }>(
        SEL.toolbar,
        `function () {
          return {
            role: this.getAttribute('role'),
            label: this.getAttribute('aria-label'),
            buttons: Array.from(this.querySelectorAll('button')).map((b) => ({ tag: b.tagName, type: b.getAttribute('type'), name: b.textContent.trim() })),
          };
        }`,
      );
      expect(info?.role).toBe('toolbar');
      expect((info?.label ?? '').length).toBeGreaterThan(3);
      expect(info?.buttons.map((b) => b.name)).toEqual(['Lookup', 'Speak', '0.75×']);
      await clickAction(page, 'explain');
      const status = await toolbar(page).evalIn<string | null>(
        SEL.card,
        `function () { return this.getAttribute('role') || (this.querySelector('[role=status]') ? 'status' : null); }`,
      );
      const live = await toolbar(page).evalIn<string | null>(
        null,
        `function () { return this.querySelector('[role=status],[aria-live]') ? 'live' : null; }`,
      );
      expect(
        status === 'status' || live === 'live',
        'state changes are announced through a live region',
      ).toBe(true);
    });
  });

  test('automated accessibility check (axe-core, WCAG 2.x A and AA) passes on the open toolbar and card', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      const withButtons = await axeOnToolbar(page);
      await clickAction(page, 'explain');
      expect(await readCardText(page)).toBe('bank');
      const withCard = await axeOnToolbar(page);
      expect(withButtons, 'toolbar').toEqual([]);
      expect(withCard, 'toolbar with card').toEqual([]);
    });
  });

  test('axe-core also passes on a dark page (contrast does not depend on the page theme)', async () => {
    await withFixture('dark-mode', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'The observatory keeps', text: 'observatory' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      expect(await axeOnToolbar(page)).toEqual([]);
    });
  });

  test('keyboard-only flow: select all, move focus into the toolbar, choose with Enter, dismiss with Escape', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await page.mouse.click(5, 5);
      await page.keyboard.press('Control+a');
      expect(await expectShown(page), 'toolbar for the keyboard selection').toBe(true);
      const reply = await openViaCommand(harness.ext.serviceWorker, page);
      expect(reply?.shown).toBe(true);
      expect(await toolbar(page).focusedAction()).toBe('explain');
      expect(await toolbar(page).focusedAction()).toBe('explain');
      await page.keyboard.press('Enter');
      await waitFor(
        async () => (await toolbar(page).attr(SEL.card, 'data-action')) === 'explain',
        3000,
        40,
      );
      expect(await toolbar(page).attr(SEL.card, 'data-action')).toBe('explain');
      await page.keyboard.press('Escape');
      expect(await expectHidden(page), 'Escape closes it from inside').toBe(true);
      const focusInToolbar = await page.evaluate(
        () => document.activeElement?.matches('div[popover]') ?? false,
      );
      expect(focusInToolbar, 'focus is not left on the hidden toolbar').toBe(false);
    });
  });

  test('Tab does not trap: from the toolbar, Tab moves on to the page', async () => {
    await withFixture('product-tabs', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'wooden handle stays cool', text: 'handle' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      await openViaCommand(harness.ext.serviceWorker, page);
      expect(await toolbar(page).focusedAction()).toBe('explain');
      // Lookup, Speak and speed are each a tab stop; one more Tab leaves the toolbar.
      let presses = 0;
      while ((await toolbar(page).focusedAction()) !== null && presses < 6) {
        await page.keyboard.press('Tab');
        presses++;
      }
      expect(await toolbar(page).focusedAction(), 'focus has left the toolbar buttons').toBeNull();
      expect(presses, 'Tab passes through the three buttons and moves on').toBeLessThanOrEqual(4);
    });
  });

  test('the focused button has a visible focus indicator', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      await openViaCommand(harness.ext.serviceWorker, page);
      const style = await toolbar(page).evalIn<{
        focusVisible: boolean;
        outlineStyle: string;
        focusedBackground: string;
        restingBackground: string;
      }>(
        null,
        `function () {
          const el = this.activeElement;
          if (!el) return null;
          const cs = getComputedStyle(el);
          const focusVisible = el.matches(':focus-visible');
          const outlineStyle = cs.outlineStyle;
          const focusedBackground = cs.backgroundColor;
          el.blur();
          return { focusVisible, outlineStyle, focusedBackground, restingBackground: getComputedStyle(el).backgroundColor };
        }`,
      );
      expect(style, 'a button has focus').not.toBeNull();
      expect(style?.focusVisible, 'keyboard focus shows as :focus-visible').toBe(true);
      expect(style?.outlineStyle).toBe('none');
      expect(style?.focusedBackground, `focus indicator: ${JSON.stringify(style)}`).not.toBe(
        style?.restingBackground,
      );
    });
  });

  test('click targets are at least 24x24 CSS px (WCAG 2.5.8)', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      for (const action of ['listen', 'slow', 'explain'] as const) {
        const box = await toolbar(page).box(actionSelector(action));
        expect(box.width, `${action} width`).toBeGreaterThanOrEqual(24);
        expect(box.height, `${action} height`).toBeGreaterThanOrEqual(24);
      }
    });
  });

  test('prefers-reduced-motion: no animation or transition runs in the toolbar', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      await clickAction(page, 'explain');
      const motion = await toolbar(page).evalIn<{ animated: string[]; running: number }>(
        null,
        `function () {
          const animated = [];
          for (const el of this.querySelectorAll('*')) {
            const cs = getComputedStyle(el);
            const hasAnimation = cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0;
            const durations = cs.transitionDuration.split(',').map((d) => parseFloat(d));
            const hasTransition = cs.transitionProperty !== 'none' && durations.some((d) => d > 0);
            if (hasAnimation || hasTransition) animated.push(el.tagName + '.' + el.className);
          }
          return { animated, running: document.getAnimations ? 0 : 0 };
        }`,
      );
      expect(
        motion?.animated,
        'elements with animation or transition under reduced motion',
      ).toEqual([]);
      const running = await page.evaluate(() => document.getAnimations().length);
      expect(running, 'no animations running in the document').toBe(0);
    });
  });

  test('forced colors (high contrast): buttons keep a border or outline', async () => {
    await withFixture('plain-baseline', async ({ page }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await selectText(
        page,
        page,
        { context: 'sat on the bank of the river', text: 'bank' },
        'dblclick',
      );
      expect(await expectShown(page)).toBe(true);
      const style = await toolbar(page).evalIn<{ border: number; outline: string }>(
        SEL.action('listen'),
        `function () { const cs = getComputedStyle(this); return { border: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth), outline: cs.outlineStyle }; }`,
      );
      expect(
        (style?.border ?? 0) > 0 || (style?.outline ?? 'none') !== 'none',
        JSON.stringify(style),
      ).toBe(true);
    });
  });

  test('the over-limit state is accessible too (axe-core on "Selection too long")', async () => {
    await withFixture('long-passage', async ({ page }) => {
      const target = fixtureById('long-passage').targets[1];
      await selectText(
        page,
        page,
        { paragraph: '#lp-long', startsWith: target?.startsWith ?? '' },
        'triple',
      );
      expect(await expectShown(page)).toBe(true);
      expect(await readMode(page)).toBe('too-long');
      expect(await axeOnToolbar(page)).toEqual([]);
    });
  });
});

// --------------------------------------------------------------------------------------------
test.describe('Selection constraints: 2,000 characters, "Selection too long", trimming', () => {
  async function selectLong(page: Page, id: string, startsWith: string): Promise<void> {
    await selectText(page, page, { paragraph: id, startsWith }, 'triple');
    expect(await expectShown(page)).toBe(true);
  }

  test('over the limit: the toolbar shows "Selection too long" with the single action "Use the first 2,000 characters"', async () => {
    await withFixture('long-passage', async ({ page }) => {
      const target = fixtureById('long-passage').targets[1];
      await selectLong(page, '#lp-long', target?.startsWith ?? '');
      const text = await rootText(page);
      expect(text).toMatch(/Selection too long/i);
      const names = await buttonNames(page);
      expect(names, 'the only action offered').toHaveLength(1);
      expect(names[0]).toMatch(/Use the first 2,000 characters/i);
      expect(
        await toolbar(page).isShown(SEL.action('explain')),
        'Explain is not offered for an over-long selection',
      ).toBe(false);
    });
  });

  test('trimming shows the trimmed text before anything is sent and caps it at 2,000 characters without splitting an emoji', async () => {
    await withFixture('long-passage', async ({ page }) => {
      const target = fixtureById('long-passage').targets[1];
      await selectLong(page, '#lp-long', target?.startsWith ?? '');
      const full = await selectedText(page);
      expect(full.length).toBeGreaterThan(2000);
      const requestsBefore = harness.groqRequests.length;
      await clickAction(page, 'trim');
      await waitFor(
        async () => (await toolbar(page).text(SEL.trimmedText)) !== undefined,
        1500,
        40,
      );
      const trimmed = (await toolbar(page).text(SEL.trimmedText)) ?? '';
      expect(trimmed.length, 'at most 2,000 UTF-16 units').toBeLessThanOrEqual(2000);
      expect(trimmed.length, 'it keeps almost all of the allowed text').toBeGreaterThan(1990);
      expect(full.startsWith(trimmed), 'it is the START of the selection').toBe(true);
      // The emoji straddles unit 2,000: it must be dropped whole, never left as a lone surrogate.
      const last = trimmed.charCodeAt(trimmed.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff, 'no dangling high surrogate').toBe(false);
      expect(trimmed).not.toContain('\u{1F600}');
      // Nothing was sent: the trimmed text is shown first, the user still has to act.
      expect(harness.groqRequests.length).toBe(requestsBefore);
      expect(await readMode(page), 'the actions come back for the trimmed text').toBe('actions');
      expect(await buttonNames(page)).toEqual(['Lookup', 'Speak', 'Slower speech, 0.75×']);
      await clickAction(page, 'explain');
      expect((await readCardText(page)) ?? '').toBe(trimmed.slice(0, 200));
    });
  });

  test('the boundary: exactly 2,000 characters is allowed, 2,001 is too long', async () => {
    await withPath('limit-boundary.html', async ({ page }) => {
      const probe = async (id: string): Promise<string | null | undefined> => {
        const first = await page.evaluate(
          (selector) =>
            (document.querySelector(selector)?.textContent ?? '').trim().split(/\s+/)[0] ?? '',
          id,
        );
        await selectText(page, page, { paragraph: id, startsWith: first }, 'triple');
        expect(await expectShown(page), id).toBe(true);
        return readMode(page);
      };
      expect(await probe('#lb-2000'), '2,000 characters').toBe('actions');
      await resetPage(page);
      expect(await probe('#lb-2001'), '2,001 characters').toBe('too-long');
    });
  });
});
