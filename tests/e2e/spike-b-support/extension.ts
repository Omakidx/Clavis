import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Default build used by the specs; `CLAVIS_EXTENSION_DIR` points them at another build. */
export const defaultBuildDir = path.resolve(
  repoRoot,
  process.env['CLAVIS_EXTENSION_DIR'] ?? '.output/chrome-mv3',
);

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
  /**
   * Declare the `explain-selection` keyboard command (Alt+Shift+E) in the test copy. The shipped
   * manifest has it since Phase 4 preparation, so this is a no-op kept for older specs.
   */
  command?: boolean;
  /**
   * Real, visible Chromium (needs a display: `xvfb-run -a`). The window keeps its natural
   * size (no viewport emulation) so native UI such as Chrome's permission prompt and the
   * context menu can be driven with xdotool.
   */
  headed?: boolean;
  /** Override browser mode while retaining Playwright's normal viewport (timing benchmarks). */
  headless?: boolean;
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
  const cleanup = () => rm(root, { recursive: true, force: true }).catch(() => undefined);
  try {
    await cp(source, dir, { recursive: true });
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    if (options.grantedSiteAccess === true) {
      const origins = manifest.optional_host_permissions ?? [];
      manifest.host_permissions = [...(manifest.host_permissions ?? []), ...origins];
      delete manifest.optional_host_permissions;
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
    return { dir, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Launch Chromium with a (possibly manifest-patched copy of the) extension in a fresh profile. */
export async function launchExtension(options: ExtensionOptions = {}): Promise<LaunchedExtension> {
  // Leave time for registration and cleanup before the benchmark's 60s setup hook expires.
  // Playwright's default browser-launch timeout is longer than that hook.
  const deadline = Date.now() + 40_000;
  const remaining = (): number => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('Extension startup deadline exceeded');
    return ms;
  };
  const copy = await prepareCopy(options);
  let userDataDir: string | undefined;
  let context: BrowserContext | undefined;
  try {
    userDataDir = await mkdtemp(path.join(tmpdir(), 'clavis-profile-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      timeout: remaining(),
      headless:
        options.headed === true
          ? false
          : (options.headless ?? process.env['CLAVIS_E2E_HEADED'] !== '1'),
      ...(options.headed === true ? { viewport: null } : {}),
      args: [`--disable-extensions-except=${copy.dir}`, `--load-extension=${copy.dir}`],
    });
    // Fresh-profile installation can take longer on Windows runners. This is a setup deadline,
    // separate from the functional request, cancellation, and toolbar latency budgets.
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: Math.min(30_000, remaining()) }));
    const activeContext = context;
    const profile = userDataDir;
    return {
      context,
      serviceWorker,
      extensionId: new URL(serviceWorker.url()).host,
      async close() {
        try {
          await activeContext.close();
        } finally {
          await copy.cleanup();
          await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
            () => undefined,
          );
        }
      },
    };
  } catch (error) {
    // A failed beforeAll never receives the handle below, so it cannot close this browser itself.
    await context?.close().catch(() => undefined);
    await copy.cleanup();
    if (userDataDir !== undefined) {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

/** Wait until the background has registered the observer (granted builds only). */
export async function waitForRegistration(serviceWorker: Worker): Promise<void> {
  const deadline = Date.now() + 10_000;
  const registeredIds = async (): Promise<string[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        serviceWorker.evaluate(
          `chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id))`,
        ) as Promise<string[]>,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('observer registration timed out')),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  for (;;) {
    const ids = await registeredIds();
    if (ids.includes('clavis-observer')) {
      // Startup and onInstalled both reconcile; let them settle so a page never loads in a gap.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const again = await registeredIds();
      if (again.includes('clavis-observer')) return;
    }
    if (Date.now() > deadline) throw new Error('observer was never registered');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
