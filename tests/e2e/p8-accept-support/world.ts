import type { Page } from '@playwright/test';
import { contentWorld } from '../p3-support/content-world';
import { fakeGroq, type FakeGroq } from '../p5-support/groq';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from '../spike-b-support/extension';
import { startFixtureServer, type FixtureServer } from '../spike-b-support/server';
import { trackGroqRequests } from '../spike-b-support/page';

// Fake keys MUST start with gsk_TEST (gitleaks allowlist).
export const ACCEPT_KEY = 'gsk_TESTp8AcceptFakeKeyDoNotUse00000AbCd';

/**
 * A brand-new Chrome profile with the PRODUCTION build (CLAVIS_EXTENSION_DIR) installed, a fixture
 * web server, and Groq answered by the test. Nothing is seeded: no key, no onboarding state, no
 * preferences. The install-time onboarding tab is what a new user sees first.
 *
 * `granted: true` is the stand-in for the user allowing website access in Chrome's prompt (the
 * prompt itself cannot be clicked from headless Playwright; the real-UI specs click the real one).
 */
export interface World {
  server: FixtureServer;
  ext: LaunchedExtension;
  groq: FakeGroq;
  /** Every request to api.groq.com seen by any page or the worker, in order. */
  groqUrls: string[];
  /** The tab the extension opens on install. */
  onboarding: Page;
  close(): Promise<void>;
}

export interface WorldOptions {
  granted: boolean;
  headed?: boolean;
}

export async function startWorld(options: WorldOptions): Promise<World> {
  const server = await startFixtureServer();
  const ext = await launchExtension({
    grantedSiteAccess: options.granted,
    ...(options.headed === true ? { headed: true } : {}),
  });
  const groqUrls = trackGroqRequests(ext.context);
  const groq = await fakeGroq(ext.context);
  if (options.granted) await waitForRegistration(ext.serviceWorker);
  const onboarding = await installTab(ext);
  return {
    server,
    ext,
    groq,
    groqUrls,
    onboarding,
    async close() {
      await ext.close();
      await server.close();
    },
  };
}

/** The welcome page Chrome shows after install (FR-001), waited for like a person would. */
async function installTab(ext: LaunchedExtension): Promise<Page> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = ext.context.pages().find((p) => p.url().endsWith('/onboarding.html'));
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error('the welcome page never opened after install');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Open a fixture web page and wait until the observer content script runs in it. */
export async function openWebpage(
  world: World,
  path = 'article.html',
): Promise<{ page: Page; dispose(): Promise<void> }> {
  const page = await world.ext.context.newPage();
  const content = await contentWorld(page);
  await page.goto(`${world.server.origin}/${path}`);
  await content.ready();
  return {
    page,
    async dispose() {
      await content.dispose();
      await page.close();
    },
  };
}
