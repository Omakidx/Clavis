import { expect, test } from './fixtures';
import {
  dragSelectSpan,
  fixtureInfo,
  measureAlignment,
  openFixtureReady,
  openReader,
  setZoom,
  selectionEquals,
  type FixtureSentence,
} from './spike-c-helpers';

// Synthetic mouse events wait for renderer frames, so these tests are slow on a loaded machine.
test.describe.configure({ timeout: 120_000 });

const first = (file: string, index = 0): FixtureSentence => fixtureInfo(file).sentences[index]!;

/** Page's text layer spans are laid over the canvas drawing: boxes must agree within a few px. */
const ALIGNMENT_TOLERANCE_PX = { left: 4, right: 6, verticalCenterRatio: 0.3 };

test.describe('Spike C: reader renders a local PDF with the bundled PDF.js viewer', () => {
  test('1-page PDF shows page count, canvas and a populated text layer', async ({
    context,
    extensionId,
  }) => {
    const { page, problems } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    await expect(page.getByTestId('page-count')).toHaveText('of 1');
    await expect(page.getByTestId('page-input')).toHaveValue('1');
    const spans = await page
      .locator('.page[data-page-number="1"] .textLayer span')
      .allTextContents();
    expect(spans).toContain(first('text-1page.pdf').text);
    expect(problems).toEqual([]);
  });

  test('selecting a sentence yields the exact string and page, aligned at 100%, 125%, 175% and fit-width', async ({
    context,
    extensionId,
  }) => {
    const { page, problems } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    const sentence = first('text-1page.pdf');
    const report: string[] = [];

    for (const zoom of ['1', '1.25', '1.75', 'page-width']) {
      await test.step(`zoom ${zoom}`, async () => {
        await setZoom(page, zoom);
        await page.mouse.click(3, 3); // clear any previous selection
        const g = await measureAlignment(page, sentence.text);
        const lineHeight = g.spanBottom - g.spanTop;
        const dLeft = Math.abs(g.inkLeft - g.spanLeft);
        const dRight = Math.abs(g.inkRight - g.spanRight);
        const dCenter = Math.abs((g.inkTop + g.inkBottom) / 2 - (g.spanTop + g.spanBottom) / 2);
        report.push(
          `zoom=${zoom} scale=${g.scale.toFixed(3)} dLeft=${dLeft.toFixed(1)} dRight=${dRight.toFixed(1)} dCenter=${dCenter.toFixed(1)} lineH=${lineHeight.toFixed(1)}`,
        );
        expect(dLeft, 'left edge of text layer vs drawn ink').toBeLessThanOrEqual(
          ALIGNMENT_TOLERANCE_PX.left,
        );
        expect(dRight, 'right edge of text layer vs drawn ink').toBeLessThanOrEqual(
          ALIGNMENT_TOLERANCE_PX.right,
        );
        expect(dCenter, 'vertical centre of text layer vs drawn ink').toBeLessThanOrEqual(
          lineHeight * ALIGNMENT_TOLERANCE_PX.verticalCenterRatio,
        );

        await dragSelectSpan(page, sentence.text);
        await selectionEquals(page, sentence.text);
        // The developer panel shows the validated pdf SelectionSnapshot.
        await expect(page.getByTestId('selection-text')).toHaveText(sentence.text);
        await expect(page.getByTestId('selection-page')).toHaveAttribute('data-page', '1');
        await expect(page.locator('.reader-selection [data-source]')).toHaveAttribute(
          'data-source',
          'pdf',
        );
        await expect(page.locator('.reader-selection [data-source]')).toHaveAttribute(
          'data-kind',
          'sentence',
        );
      });
    }
    console.log(`[spike-c] alignment\n${report.join('\n')}`);
    expect(problems).toEqual([]);
  });

  test('multi-column page: each column line selects exactly, independent of reading order', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'multi-column.pdf');
    await setZoom(page, '1');
    const lines = fixtureInfo('multi-column.pdf').sentences;
    const left = lines.find((l) => l.text === 'Left column line 2.')!;
    const right = lines.find((l) => l.text === 'Right column line 2.')!;
    for (const line of [left, right]) {
      await page.mouse.click(3, 3);
      await dragSelectSpan(page, line.text);
      await selectionEquals(page, line.text);
    }
  });

  test('90-degree rotated page: text layer is aligned and selection still works', async ({
    context,
    extensionId,
  }) => {
    // Taller window: a rotated line runs top to bottom and must fit on screen to be dragged.
    const { page } = await openReader(context, extensionId, { width: 1100, height: 1300 });
    await openFixtureReady(page, 'rotated-page.pdf');
    const sentence = first('rotated-page.pdf');
    for (const zoom of ['1', '1.25']) {
      await setZoom(page, zoom);
      await page.mouse.click(3, 3);
      const g = await measureAlignment(page, sentence.text);
      console.log(
        `[spike-c] rotated zoom=${zoom} dStart=${Math.abs(g.inkTop - g.spanTop).toFixed(1)} dEnd=${Math.abs(g.inkBottom - g.spanBottom).toFixed(1)} ` +
          `dAcross=${Math.abs((g.inkLeft + g.inkRight) / 2 - (g.spanLeft + g.spanRight) / 2).toFixed(1)} thickness=${(g.spanRight - g.spanLeft).toFixed(1)}`,
      );
      // Rotated text runs top to bottom: compare the vertical extent along the line, and
      // the horizontal position across it.
      expect(Math.abs(g.inkTop - g.spanTop), 'start of line').toBeLessThanOrEqual(6);
      expect(Math.abs(g.inkBottom - g.spanBottom), 'end of line').toBeLessThanOrEqual(6);
      const width = g.spanRight - g.spanLeft;
      expect(
        Math.abs((g.inkLeft + g.inkRight) / 2 - (g.spanLeft + g.spanRight) / 2),
        'across the line',
      ).toBeLessThanOrEqual(width * 0.3);
      await dragSelectSpan(page, sentence.text, { vertical: true });
      await selectionEquals(page, sentence.text);
    }
  });
});
