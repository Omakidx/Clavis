import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { FAKE_KEY, openExtensionPage, send } from '../p3-support/background';
import { CARD, chatBody, explainWord } from '../p5-card-support/harness';
import { fakeGroq } from '../p5-support/groq';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from '../spike-b-support/extension';
import { startFixtureServer, type FixtureServer } from '../spike-b-support/server';

declare const indexedDB: IDBFactory;

/**
 * One browser profile (its own persistent context and user-data dir) running the built extension
 * against the local stack. Groq is answered by the test; the account/sync traffic is real.
 */
export interface Profile {
  ext: LaunchedExtension;
  server: FixtureServer;
  /** Next answer of the library chat tutor. */
  tutor: { answer: string };
  options(): Promise<Page>;
  /** Explain `word` on the fixture article and press Save on the card. */
  saveWord(word: string): Promise<void>;
  /** A fresh Library page (words tab). */
  library(): Promise<Page>;
  /** Worker console lines and API traffic (bodies included) seen so far, for failure evidence. */
  evidence: { console: string[]; api: string[] };
  close(): Promise<void>;
}

export async function startProfile(buildDir: string): Promise<Profile> {
  const server = await startFixtureServer();
  const ext = await launchExtension({ buildDir, grantedSiteAccess: true });
  const groq = await fakeGroq(ext.context);
  const tutor = { answer: 'It comes from Greek.' };
  await ext.context.route('https://api.groq.com/**/chat/completions', async (route) => {
    const body = route.request().postDataJSON() as { messages: { content: string }[] };
    if (!body.messages[0]?.content.includes('vocabulary tutor')) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chatBody(tutor.answer),
    });
  });
  const evidence = { console: [] as string[], api: [] as string[] };
  const stamp = (): string => new Date().toISOString();
  ext.serviceWorker.on('console', (m) =>
    evidence.console.push(`${stamp()} ${m.type()} ${m.text()}`),
  );
  ext.context.on('response', (response) => {
    const url = response.url();
    if (!url.startsWith('http://localhost:8787/')) return;
    const request = response.request();
    void response
      .text()
      .catch(() => '<no body>')
      .then((text) =>
        evidence.api.push(
          `${stamp()} ${request.method()} ${url} -> ${response.status()}\n  req: ${request.postData() ?? ''}\n  res: ${text.slice(0, 2000)}`,
        ),
      );
  });
  await waitForRegistration(ext.serviceWorker);
  const page = await openExtensionPage(ext.context, ext.extensionId, 'options');
  await send(page, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
  await send(page, { v: 1, type: 'ACCEPT_DISCLOSURE' });
  groq.reset();
  await page.close();
  return {
    ext,
    server,
    tutor,
    evidence,
    async options() {
      const page = await ext.context.newPage();
      await page.goto(`chrome-extension://${ext.extensionId}/options.html#section-account`);
      return page;
    },
    library: () => openExtensionPage(ext.context, ext.extensionId, 'library'),
    async saveWord(word) {
      const page = await ext.context.newPage();
      try {
        await page.goto(`${server.origin}/article.html`);
        const card = await explainWord(page, word);
        await card.waitFor(CARD.ready('core'));
        await card.waitFor('[data-clavis="card-save"]');
        await card.click('[data-clavis="card-save"]');
        await expect
          .poll(async () => (await card.text('[data-clavis="card-save"]')) ?? '', {
            timeout: 10_000,
          })
          .toBe('Saved');
      } finally {
        await page.close();
      }
    },
    async close() {
      await ext.close();
      await server.close();
    },
  };
}

/** Every record of every store of clavis-data, read from an extension page. */
export function dumpDb(page: Page): Promise<Record<string, Record<string, unknown>[]>> {
  return page.evaluate(
    () =>
      new Promise<Record<string, Record<string, unknown>[]>>((resolve, reject) => {
        const open = indexedDB.open('clavis-data', 1);
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const names = [...db.objectStoreNames];
          const tx = db.transaction(names);
          const out: Record<string, Record<string, unknown>[]> = {};
          let left = names.length;
          for (const name of names) {
            const request = tx.objectStore(name).getAll();
            request.onsuccess = () => {
              out[name] = request.result as Record<string, unknown>[];
              if (--left === 0) {
                db.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );
}
