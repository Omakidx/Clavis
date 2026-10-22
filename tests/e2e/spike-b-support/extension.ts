import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Default build used by the functional specs (variant a). */
export const defaultBuildDir = path.resolve(
  repoRoot,
  process.env['CLAVIS_EXTENSION_DIR'] ?? '.output/chrome-mv3',
);

export function buildDirFor(variant: 'a' | 'b' | 'c'): string {
  return path.resolve(repoRoot, `.output-spike-b-${variant}/chrome-mv3`);
}

export interface ExtensionOptions {
  /** Unpacked build to load. */
  buildDir?: string;
  /**
   * Stand-in for the user granting site access. Chrome's permission prompt cannot be
   * clicked from Playwright, so the test copy lists the optional origins as REQUIRED
   * host permissions; Chrome then reports them as granted. Everything downstream
   * (permissions.contains, registerContentScripts, injection) is the real code.
   */
  grantedSiteAccess?: boolean;
  /** Declare the UI chunk as web-accessible with use_dynamic_url (option b). */
  webAccessibleUi?: boolean;
  /**
   * Declare the proposed `explain-selection` keyboard command (Alt+Shift+E) in the test copy.
   * The shipped manifest does not have it yet: wxt.config.ts is the manager's file.
   */
  command?: boolean;
  /**
   * Real, visible Chromium (needs a display: `xvfb-run -a`). The window keeps its natural
   * size (no viewport emulation) so native UI such as Chrome's permission prompt and the
   * context menu can be driven with xdotool.
   */
  headed?: boolean;
}

export interface LaunchedExtension {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  close(): Promise<void>;
}

type Manifest = {
  host_permissions?: string[];
  optional_host_permissions?: string[];
  web_accessible_resources?: unknown[];
  commands?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Copy the build to a temp dir and patch only its manifest. The build output itself is never touched. */
async function prepareCopy(
  options: ExtensionOptions,
): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const source = options.buildDir ?? defaultBuildDir;
  const root = await mkdtemp(path.join(tmpdir(), 'clavis-ext-'));
  const dir = path.join(root, 'ext');
  await cp(source, dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  if (options.grantedSiteAccess === true) {
    const origins = manifest.optional_host_permissions ?? [];
    manifest.host_permissions = [...(manifest.host_permissions ?? []), ...origins];
    delete manifest.optional_host_permissions;
  }
  if (options.webAccessibleUi === true) {
    manifest.web_accessible_resources = [
      {
        resources: ['content-scripts/content-ui.js'],
        matches: ['http://*/*', 'https://*/*'],
        use_dynamic_url: true,
      },
    ];
  }
  if (options.command === true) {
    manifest.commands = {
      'explain-selection': {
        suggested_key: { default: 'Alt+Shift+E' },
        description: '__MSG_toolbarCommandExplain__',
      },
    };
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { dir, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => undefined) };
}

/** Launch Chromium with a (possibly manifest-patched copy of the) extension in a fresh profile. */
export async function launchExtension(options: ExtensionOptions = {}): Promise<LaunchedExtension> {
  const copy = await prepareCopy(options);
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'clavis-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: options.headed === true ? false : process.env['CLAVIS_E2E_HEADED'] !== '1',
    ...(options.headed === true ? { viewport: null } : {}),
    args: [`--disable-extensions-except=${copy.dir}`, `--load-extension=${copy.dir}`],
  });
  const serviceWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  return {
    context,
    serviceWorker,
    extensionId: new URL(serviceWorker.url()).host,
    async close() {
      await context.close();
      await copy.cleanup();
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    },
  };
}

/** Wait until the background has registered the observer (granted builds only). */
export async function waitForRegistration(serviceWorker: Worker): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const ids = (await serviceWorker.evaluate(
      `chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id))`,
    )) as string[];
    if (ids.includes('clavis-observer')) {
      // Startup and onInstalled both reconcile; let them settle so a page never loads in a gap.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const again = (await serviceWorker.evaluate(
        `chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id))`,
      )) as string[];
      if (again.includes('clavis-observer')) return;
    }
    if (Date.now() > deadline) throw new Error('observer was never registered');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
