import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  bearerFor,
  docChanges,
  makePdf,
  push,
  uniqueEmail,
  uploadPdf,
  wordChanges,
  type Bearer,
  type DocSeed,
  type WordSeed,
} from './api';
import { API_ORIGIN } from './stack';

export { expect };
export const filesReady = (): boolean => process.env['E2E_FILES_READY'] === '1';
export const FILES_SKIP_REASON =
  'The file endpoints (PUT/GET/DELETE /v1/documents/:fp/file) are not on the running server yet.';

/**
 * Makes the real `/auth/google/start` redirect pick `email` at the fake Google: the server's redirect carries no
 * login hint, so the Location header of its own 302 (and its OAuth cookie) is passed through with one added.
 */
export async function routeGoogleAs(context: BrowserContext | Page, email: string): Promise<void> {
  await context.route('**/auth/google/start*', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers()['location'];
    if (!location) return route.fulfill({ response });
    const url = new URL(location);
    url.searchParams.set('login_hint', email);
    return route.fulfill({
      response,
      headers: { ...response.headers(), location: url.toString() },
    });
  });
}

/** Real sign-in: landing page -> /auth/google/start -> fake Google -> callback cookie -> /words. */
export async function signIn(page: Page, email: string): Promise<void> {
  await routeGoogleAs(page, email);
  for (let attempt = 0; ; attempt++) {
    await page.goto('/');
    await page.getByRole('link', { name: 'Sign in with Google' }).click();
    try {
      await page.waitForURL('**/words', { timeout: 10_000 });
      const session = await page.evaluate(
        async () => (await fetch('/v1/session')).json() as Promise<{ user: { email: string } }>,
      );
      if (session.user.email !== email)
        throw new Error(`signed in as ${session.user.email}, expected ${email}`);
      return;
    } catch (e) {
      // Per-IP auth rate limit (20/min) when a run signs in a lot; wait and retry once.
      if (attempt >= 1 || (e instanceof Error && e.message.startsWith('signed in as'))) throw e;
      await page.waitForTimeout(15_000);
    }
  }
}

export interface Account {
  email: string;
  bearer: Bearer;
}

interface Fixtures {
  /** Watches every page of the test for CSP violations and uncaught page errors. */
  guard: string[];
  /** A fresh user with the given data seeded through the API (Bearer push), not yet signed in. */
  seed: (data?: { words?: WordSeed[]; docs?: DocSeed[] }) => Promise<Account>;
  /** A signed-in page for a fresh user seeded with `seed(...)`. */
  signedIn: (data?: Parameters<Fixtures['seed']>[0]) => Promise<{ page: Page; account: Account }>;
  axe: (page: Page) => Promise<void>;
}

interface WorkerFixtures {
  readerStorage: Awaited<ReturnType<BrowserContext['storageState']>>;
  reader: Account;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  guard: [
    async ({ context }, use, testInfo) => {
      const problems: string[] = [];
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          console.error(`CSPVIOLATION ${e.violatedDirective} ${e.blockedURI}`);
        });
      });
      const watch = (page: Page): void => {
        page.on('console', (m) => {
          const text = m.text();
          if (/CSPVIOLATION|Content Security Policy|Refused to (apply|execute|load)/i.test(text)) {
            problems.push(text);
          }
        });
        page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      };
      context.pages().forEach(watch);
      context.on('page', watch);
      await use(problems);
      expect(problems, `CSP violations / page errors in ${testInfo.title}`).toEqual([]);
    },
    { auto: true },
  ],

  seed: async ({}, use) => {
    await use(async (data = {}) => {
      const email = uniqueEmail('t');
      const bearer = await bearerFor(email);
      const changes = [
        ...(await Promise.all((data.words ?? []).map((w) => wordChanges(w)))).flat(),
        ...(data.docs ?? []).flatMap((d) => docChanges(d)),
      ];
      if (changes.length > 0) await push(bearer, changes);
      return { email, bearer };
    });
  },

  signedIn: async ({ page, seed }, use) => {
    await use(async (data) => {
      const account = await seed(data);
      await signIn(page, account.email);
      return { page, account };
    });
  },

  axe: async ({}, use) => {
    await use(async (page) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      const bad = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        bad.map(
          (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
        ),
      ).toEqual([]);
    });
  },

  // One real sign-in for the read-only tests (they never mutate the reader's data).
  reader: [
    async ({}, use) => {
      const email = uniqueEmail('reader');
      const bearer = await bearerFor(email);
      await use({ email, bearer });
    },
    { scope: 'worker' },
  ],
  readerStorage: [
    async ({ browser, reader }, use) => {
      const state = await signInState(browser, reader);
      await use(state);
    },
    { scope: 'worker' },
  ],
});

async function signInState(browser: Browser, reader: Account) {
  const context = await browser.newContext({ baseURL: API_ORIGIN });
  const page = await context.newPage();
  const files = filesReady();
  const stored = makePdf(`reader-stored-${reader.email}`);
  const words: WordSeed[] = [];
  for (let i = 0; i < 30; i++) {
    words.push({ text: `alpha-${String(i).padStart(2, '0')}`, at: i });
  }
  words.push(
    {
      text: '<img src=x onerror="window.__pwned=1">',
      summary: '<script>window.__pwned=1</script> summary',
      at: 100,
      meaning: {
        definition: '<b>bold</b> definition',
        contextualMeaning: '<img src=x onerror="window.__pwned=1"> in context',
        examples: [{ sentence: '<i>example</i> sentence', note: '<u>note</u>' }],
        caveat: '<svg onload="window.__pwned=1"> careful',
      },
      contextBefore: 'Before <b>bold</b> ',
      contextAfter: ' after <script>window.__pwned=1</script>',
      source: {
        kind: 'webpage',
        url: 'https://example.com/path?q=1',
        title: '<b>Title</b> of page',
      },
      chat: [
        { role: 'user', content: 'What is <img src=x onerror="window.__pwned=1"> ?' },
        {
          role: 'assistant',
          content: 'It is **not** HTML.\nSecond line <script>window.__pwned=1</script>',
        },
      ],
    },
    {
      text: 'ephemeral',
      at: 101,
      meaning: {
        definition: 'Lasting a very short time.',
        contextualMeaning: 'Used here to mean brief.',
      },
      contextBefore: 'The joy was ',
      contextAfter: ' but lovely.',
      chat: [
        { role: 'user', content: 'Give me a synonym.' },
        { role: 'assistant', content: 'Fleeting or transient.' },
      ],
    },
    {
      text: 'pdf-word',
      at: 102,
      source: { kind: 'pdf', fingerprint: stored.fingerprint, title: 'Stored paper', page: 7 },
    },
  );
  const docs: DocSeed[] = [
    {
      title: 'Stored paper',
      fingerprint: stored.fingerprint,
      pageCount: 40,
      lastPage: 12,
      at: 500,
      highlights: 3,
    },
    {
      title: 'Local only',
      fingerprint: makePdf(`reader-local-${reader.email}`).fingerprint,
      pageCount: 10,
      lastPage: null,
      at: 400,
    },
  ];
  for (let i = 0; i < 26; i++) {
    docs.push({
      title: `Bulk document ${String(i).padStart(2, '0')}`,
      fingerprint: makePdf(`bulk-${i}-${reader.email}`).fingerprint,
      pageCount: 5,
      lastPage: 2,
      at: i,
    });
  }
  await push(reader.bearer, [
    ...(await Promise.all(words.map((w) => wordChanges(w)))).flat(),
    ...docs.flatMap((d) => docChanges(d)),
  ]);
  if (files) {
    const res = await uploadPdf(reader.bearer, stored, 'Stored paper');
    if (!res.ok) throw new Error(`reader PDF upload failed: ${res.status}`);
  }
  await signIn(page, reader.email);
  const state = await context.storageState();
  await context.close();
  return state;
}

/** A page for the shared, read-only reader account (30+ words, 28 documents, an XSS-looking word). */
export const readerTest = test.extend<{ rpage: Page }>({
  rpage: async ({ browser, readerStorage }, use) => {
    const context = await browser.newContext({ storageState: readerStorage, baseURL: API_ORIGIN });
    const page = await context.newPage();
    // The guard fixture watches the default context only; watch this one too.
    const problems: string[] = [];
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`CSPVIOLATION ${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    page.on('console', (m) => {
      if (/CSPVIOLATION|Content Security Policy|Refused to (apply|execute|load)/i.test(m.text()))
        problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await use(page);
    expect(problems, 'CSP violations / page errors').toEqual([]);
    await context.close();
  },
});
