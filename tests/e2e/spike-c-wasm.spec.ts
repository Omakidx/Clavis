import type { Page } from '@playwright/test';
import { expect, extensionPath, test } from './fixtures';
import {
  launchPatchedExtension,
  meanCanvasColor,
  openFixtureReady,
  openReader,
  waitForRendersToSettle,
} from './spike-c-helpers';

test.describe.configure({ timeout: 120_000 });

/** D-17: the approved extension_pages policy (also required by scripts/expected-permissions.json). */
const APPROVED_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

/** Compile the smallest valid wasm module on the reader page and inside the PDF.js worker. */
async function probeWasm(page: Page): Promise<{ page: string; worker: string }> {
  const probe = async () => {
    try {
      await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      return 'ok';
    } catch (error) {
      return String(error).slice(0, 200);
    }
  };
  const worker = page.workers()[0];
  return {
    page: await page.evaluate(probe),
    worker: worker ? await worker.evaluate(probe) : 'no worker',
  };
}

test.describe('Spike C: WebAssembly under the adopted extension CSP (D-17)', () => {
  test('manifest carries the approved CSP; wasm works on the page and in the worker; the ICC image uses the qcms path', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const manifest = (await serviceWorker.evaluate('chrome.runtime.getManifest()')) as {
      content_security_policy?: { extension_pages?: string };
    };
    expect(manifest.content_security_policy?.extension_pages).toBe(APPROVED_CSP);

    const { page, problems } = await openReader(context, extensionId);
    await openFixtureReady(page, 'icc-image.pdf');
    await waitForRendersToSettle(page);
    expect(await probeWasm(page)).toEqual({ page: 'ok', worker: 'ok' });
    // The reader asks PDF.js for wasm only when the CSP allows it (lib/pdf/wasm.ts).
    expect(
      await page.evaluate(() => {
        try {
          new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    const color = await meanCanvasColor(page);
    expect(
      color.some((c) => c < 235),
      'the image is drawn',
    ).toBe(true);
    expect(problems).toEqual([]);

    // Reference: the same build with the CSP removed (Chrome default, wasm blocked) takes the
    // non-ICC colour path and must give a different result. This proves the shipped build
    // really runs the wasm colour transform instead of just allowing it.
    const reference = await launchPatchedExtension(extensionPath, (m) => {
      delete m['content_security_policy'];
    });
    try {
      const ref = await openReader(reference.context, reference.extensionId);
      await openFixtureReady(ref.page, 'icc-image.pdf');
      await waitForRendersToSettle(ref.page);
      const refProbe = await probeWasm(ref.page);
      expect(refProbe.page).toContain('Content Security policy');
      expect(refProbe.worker).toContain('Content Security policy');
      const refColor = await meanCanvasColor(ref.page);
      console.log(
        `[spike-c] qcms/wasm colour ${color.join(',')} vs no-wasm reference ${refColor.join(',')}`,
      );
      expect(color).not.toEqual(refColor);
    } finally {
      await reference.dispose();
    }
  });

  test('no nowasm fallback scripts are shipped or requested', async ({ context, extensionId }) => {
    const { page, requests } = await openReader(context, extensionId);
    await openFixtureReady(page, 'icc-image.pdf');
    await waitForRendersToSettle(page);
    expect(requests.filter((u) => u.includes('nowasm_fallback'))).toEqual([]);
    const res = await page.evaluate(async (id) => {
      const r = await fetch(
        `chrome-extension://${id}/pdfjs/wasm/openjpeg_nowasm_fallback.js`,
      ).catch(() => null);
      return r ? r.status : 'unreachable';
    }, extensionId);
    expect(res).not.toBe(200);
  });
});
