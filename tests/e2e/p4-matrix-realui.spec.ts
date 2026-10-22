import { expect, test, type Page } from '@playwright/test';
import { launchExtension, type LaunchedExtension } from './spike-b-support/extension';
import { realUiEnabled, rightClickBox, xdotool } from './spike-b-support/native-ui';
import { expectShown, selectText } from './p4-matrix-support/actions';
import { startMatrixServer, type MatrixServer } from './p4-matrix-support/server';
import { installProbe, locate } from './p4-matrix-support/page';
import { SEL, toolbar } from './p4-matrix-support/toolbar';

// FR-018 and the keyboard path of FR-016 with Chrome's NATIVE UI: the right-click "Explain with
// Clavis" item and the Alt+Shift+E command, all with site access
// DECLINED (nothing registered, no manifest patching), driven with xdotool.
//
// The toolbar-icon path (Extensions menu, then the popup button) is not driven here: the fixed
// screen coordinates of Chrome's puzzle menu do not resolve in this environment (the Spike B
// icon test fails the same way); the popup's route is covered in p4-matrix-access.spec.ts.
//
//   CLAVIS_E2E_REAL_UI=1 CLAVIS_EXTENSION_DIR=.output/chrome-mv3 \
//     xvfb-run -a -s "-screen 0 1920x1080x24" npx playwright test tests/e2e/p4-matrix-realui.spec.ts
//
// Opt-in: needs a display, xdotool and ImageMagick's `import`; skipped otherwise.
test.skip(!realUiEnabled, 'opt-in: set CLAVIS_E2E_REAL_UI=1 and run under xvfb-run -a');

let server: MatrixServer;
let ext: LaunchedExtension | undefined;

test.beforeAll(async () => {
  server = await startMatrixServer();
});
test.afterAll(async () => {
  await server?.close();
});
test.afterEach(async () => {
  await ext?.close();
  ext = undefined;
});

async function launch(): Promise<LaunchedExtension> {
  ext = await launchExtension({ headed: true });
  await installProbe(ext.context);
  return ext;
}

async function openPlain(extension: LaunchedExtension): Promise<Page> {
  const page = await extension.context.newPage();
  await page.goto(`${server.origin}/plain-baseline.html`);
  await page.waitForTimeout(500);
  // The install-time onboarding tab would hold the first window slot; keep only the page.
  for (const other of extension.context.pages()) if (other !== page) await other.close();
  await page.bringToFront();
  return page;
}

const registeredCount = async (extension: LaunchedExtension): Promise<number> =>
  (await extension.serviceWorker.evaluate(
    'chrome.scripting.getRegisteredContentScripts().then((s) => s.length)',
  )) as number;

test('declined access: right-click "Explain with Clavis" shows the toolbar for the selection in the current tab only (FR-018)', async () => {
  const extension = await launch();
  const page = await openPlain(extension);
  const word = await selectText(
    page,
    page,
    { context: 'sat on the bank of the river', text: 'bank' },
    'dblclick',
  );
  await page.waitForTimeout(400);
  await toolbar(page).expectNoHost();

  await rightClickBox(page, {
    x: word.center.x - 2,
    y: word.center.y - 2,
    width: 4,
    height: 4,
  });
  await page.waitForTimeout(700);
  // The extension item sits just above "Inspect": Up, Up from the unfocused menu.
  xdotool('key', 'Up');
  xdotool('key', 'Up');
  xdotool('key', 'Return');
  expect(await expectShown(page, 6000), 'toolbar after the context menu item').toBe(true);
  expect(await registeredCount(extension), 'no all-sites registration was created').toBe(0);

  const other = await extension.context.newPage();
  await other.goto(`${server.origin}/plain-baseline.html`);
  const again = await locate(other, { context: 'sat on the bank of the river', text: 'bank' });
  await other.mouse.dblclick(again.center.x, again.center.y);
  await other.waitForTimeout(600);
  await toolbar(other).expectNoHost();
});

test('keyboard shortcut Alt+Shift+E shows the toolbar and puts focus on Listen; arrows and Enter work (FR-016)', async () => {
  const extension = await launch();
  const page = await openPlain(extension);
  await selectText(
    page,
    page,
    { context: 'sat on the bank of the river', text: 'bank' },
    'dblclick',
  );
  await page.waitForTimeout(400);
  await toolbar(page).expectNoHost();
  xdotool('key', 'alt+shift+e');
  expect(await expectShown(page, 6000), 'toolbar after the shortcut').toBe(true);
  await expect.poll(() => toolbar(page).focusedAction()).toBe('listen');
  xdotool('key', 'Right');
  await expect.poll(() => toolbar(page).focusedAction()).toBe('explain');
  xdotool('key', 'Return');
  await toolbar(page).waitShown(SEL.card);
  expect(await toolbar(page).attr(SEL.card, 'data-action')).toBe('explain');
  expect(await registeredCount(extension)).toBe(0);
});
