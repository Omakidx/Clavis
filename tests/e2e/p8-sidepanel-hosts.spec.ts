import { expect, test } from './fixtures';
import { CARD, cardOf } from './p5-card-support/harness';
import { openPanelPage, panelOptions, tabIdOf } from './p8-sidepanel-support/panel';
import { openReader, waitForPhase, waitForRendersToSettle } from './p7-reader-support/helpers';
import { setUpAi } from './p7-reader-support/ai';
import { CONTEXT_WORD, contextPdf } from './p7-reader-support/pdfs';
import { gotoPage, selectWordByDoubleClick } from './p7-reader-support/select';
import { openExtensionPage } from './p3-ui-support/pages';
import { tb } from './spike-b-support/toolbar';

// Phase 8, FR-042: the card hosted by the PDF reader and the practice page has the same
// "Open in side panel" action (both are extension pages in a tab, so their sender has a tab).
test.describe.configure({ timeout: 120_000 });

test('the PDF reader opens the panel for its own tab, with the PDF page number', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const { groq } = await setUpAi(context, extensionId);
  const session = await openReader(context, extensionId);
  const { page } = session;
  await page.getByTestId('file-input').setInputFiles({
    name: 'context.pdf',
    mimeType: 'application/pdf',
    buffer: await contextPdf(),
  });
  await waitForPhase(page, 'ready');
  await gotoPage(page, 2);
  await waitForRendersToSettle(page, { quietMs: 500 });
  await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
  await tb(page).waitShown();
  await tb(page).click('explain');
  const card = cardOf(page);
  await card.waitFor(CARD.ready('core'));
  groq.reset();

  await card.click(CARD.sidePanel);
  await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
  const tabId = await tabIdOf(serviceWorker, page);
  expect(await panelOptions(serviceWorker, tabId)).toMatchObject({
    enabled: true,
    path: `sidepanel.html?tab=${tabId}`,
  });

  const panel = await openPanelPage(context, extensionId, tabId);
  await expect(panel.getByTestId('panel-selected')).toHaveText(CONTEXT_WORD);
  await expect(panel.getByText('Word · PDF page 2')).toBeVisible();
  await expect(panel.getByTestId('panel-section').first()).toHaveAttribute('data-status', 'ready');
  // The hand-off carried the PDF snapshot, so a further tab asks with the page and its context.
  await panel.getByTestId('panel-load').first().click();
  await expect.poll(() => groq.chats().length).toBe(1);
  const content = groq.chats()[0]?.body?.messages[1]?.content ?? '';
  expect(content).toContain(CONTEXT_WORD);
  expect(content).toContain('context');
});

test('the practice page opens the panel too', async ({ context, extensionId, serviceWorker }) => {
  await setUpAi(context, extensionId);
  const { page } = await openExtensionPage(context, extensionId, 'practice');
  await expect.poll(() => page.frames().some((f) => f.url() === 'about:srcdoc')).toBe(true);
  const frame = page.frames().find((f) => f.url() === 'about:srcdoc')!;
  await frame.waitForSelector('article p');
  const center = await frame.evaluate(() => {
    const node = document.querySelector('article p')!.firstChild as Text;
    const text = node.textContent ?? '';
    const at = text.indexOf('river');
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 5);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const box = await (await frame.frameElement()).boundingBox();
  await page.mouse.dblclick((box?.x ?? 0) + center.x, (box?.y ?? 0) + center.y);
  await tb(frame).waitShown();
  await tb(frame).click('explain');
  const card = cardOf(page, frame);
  await card.waitFor(CARD.ready('core'));
  await card.click(CARD.sidePanel);
  await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
  const tabId = await tabIdOf(serviceWorker, page);
  const panel = await openPanelPage(context, extensionId, tabId);
  await expect(panel.getByTestId('panel-selected')).toHaveText('river');
});
