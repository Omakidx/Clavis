import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { dumpDb, startProfile, type Profile } from './p11-support/profile';
import { buildExtension, leftoverDatabases, startStack, type Stack } from './p11-support/stack';

// Clavis Sync, end to end: the BUILT extension (Chromium, real chrome.identity.launchWebAuthFlow)
// signs in through the local fake Google, syncs with the real local API and Postgres, and
// independent browser profiles converge (docs/clavis-sync-design.md 2.2, 4, 7.7).
// Run: see the header of tests/e2e/p11-support/stack.ts and the report; the spec starts and stops
// the whole stack itself (ports 8787/8788 must be free).

const ALICE = 'alice@example.test';
const CAROL = 'carol@example.test';

test.describe.configure({ mode: 'serial', timeout: 120_000 });
test.use({ trace: 'on', screenshot: 'on' });

let stack: Stack;
let a: Profile; // alice, device 1
let b: Profile; // alice, device 2
let c: Profile; // carol
const cleanups: (() => Promise<void>)[] = [];

const serverWords = (email: string) =>
  stack.sql<{ text: string; deleted: boolean }>(
    `SELECT w.text, (w.deleted_at IS NOT NULL) AS deleted
       FROM saved_words w JOIN users u ON u.id = w.user_id
      WHERE u.email = $1 ORDER BY w.text`,
    [email],
  );
const liveServerWords = async (email: string) =>
  (await serverWords(email)).filter((w) => !w.deleted).map((w) => w.text);

/** Sign in from Options (the real button) and wait until the account is shown. */
async function signIn(p: Profile, email: string): Promise<Page> {
  const options = await p.options();
  await options.getByTestId('account-sign-in').click();
  await expect(options.getByTestId('account-email')).toContainText(email, { timeout: 30_000 });
  return options;
}

async function syncNow(options: Page): Promise<void> {
  const button = options.getByTestId('account-sync-now');
  // The page reads the sync status once and then only polls while it is visible (use-account-status:
  // 5 s). A page opened while a sync is already running (a write kicks one) shows a disabled button
  // until the next poll, so bring it to front and, if it stays disabled, reload to re-read the status.
  await options.bringToFront();
  await expect(async () => {
    if (await button.isDisabled()) {
      await options.reload();
      await options.bringToFront();
    }
    await expect(button).toBeEnabled({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await button.click();
  // Wait for a settled state (not "syncing") with no pending local changes.
  await expect(options.getByTestId('account-sync-line')).not.toContainText(/Syncing|never/i, {
    timeout: 30_000,
  });
}

/** The words the Library lists right now (fresh page, so it reads the local database). */
async function libraryWords(p: Profile): Promise<string[]> {
  const lib = await p.library();
  try {
    await expect(lib.getByTestId('library-loading')).toHaveCount(0);
    return await lib.getByTestId('library-item').locator('.library-item__text').allTextContents();
  } finally {
    await lib.close();
  }
}

/** On a failure: worker console, API traffic, both profiles' local words and the server rows. */
async function attachEvidence(testInfo: import('@playwright/test').TestInfo): Promise<void> {
  const attach = (name: string, text: string) =>
    testInfo.attach(name, { body: text, contentType: 'text/plain' });
  for (const [name, p] of [
    ['A', a],
    ['B', b],
  ] as const) {
    await attach(`${name}-worker-console`, p.evidence.console.join('\n'));
    await attach(`${name}-api-traffic`, p.evidence.api.join('\n'));
    const page = await p.options().catch(() => undefined);
    if (page) {
      const words = (await dumpDb(page).catch(() => ({}) as Record<string, unknown[]>))['words'];
      await attach(`${name}-idb-words`, JSON.stringify(words, null, 2));
      await page.close();
    }
  }
  await attach('server-saved_words', JSON.stringify(await serverWords(ALICE), null, 2));
  await attach(
    'server-saved_words-raw',
    JSON.stringify(
      await stack.sql(
        `SELECT word_key, text, client_modified_at, server_modified_at, seq, deleted_at FROM saved_words`,
      ),
      null,
      2,
    ),
  );
  await attach('stack-log', stack.log());
}

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) await attachEvidence(testInfo);
});

test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await startStack();
  const [alice, carol] = await Promise.all([buildExtension(ALICE), buildExtension(CAROL)]);
  cleanups.push(alice.cleanup, carol.cleanup);
  a = await startProfile(alice.dir);
  b = await startProfile(alice.dir);
  c = await startProfile(carol.dir);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await Promise.allSettled([a?.close(), b?.close(), c?.close()]);
  await Promise.allSettled(cleanups.map((f) => f()));
  await stack?.stop();
  expect(await leftoverDatabases()).toEqual([]);
});

test('1. a word saved while signed out is pushed by the first-sign-in merge', async () => {
  await a.saveWord('cartographer');
  expect(await liveServerWords(ALICE)).toEqual([]);

  const options = await signIn(a, ALICE);
  await expect(options.getByTestId('account-sign-out')).toBeVisible();
  await expect.poll(() => liveServerWords(ALICE), { timeout: 30_000 }).toEqual(['cartographer']);
  // The word is still in A's own library, and nothing is left to push.
  expect(await libraryWords(a)).toEqual(['cartographer']);
  await options.close();
});

test('2. the same user on a second profile gets the word after Sync now', async () => {
  const options = await signIn(b, ALICE);
  await syncNow(options);
  await expect.poll(() => libraryWords(b), { timeout: 30_000 }).toEqual(['cartographer']);
  await options.close();
});

test('3. a delete on one profile reaches the other', async () => {
  const lib = await b.library();
  await lib.getByTestId('library-item').click();
  await lib.getByTestId('library-delete').click();
  await expect(lib.getByRole('alertdialog')).toContainText('Delete "cartographer"?');
  await lib.waitForTimeout(600); // the confirm button ignores clicks right after it appears
  await lib.getByTestId('library-dialog-confirm').click();
  await expect(lib.getByTestId('library-words-empty')).toBeVisible();
  await lib.close();

  const bOptions = await b.options();
  await syncNow(bOptions);
  await expect.poll(() => liveServerWords(ALICE), { timeout: 30_000 }).toEqual([]);
  expect((await serverWords(ALICE)).map((w) => w.deleted)).toEqual([true]); // a tombstone

  const aOptions = await a.options();
  await syncNow(aOptions);
  await expect.poll(() => libraryWords(a), { timeout: 30_000 }).toEqual([]);
  await bOptions.close();
  await aOptions.close();
});

test('6. chat messages travel with the word', async () => {
  await a.saveWord('townspeople');
  const lib = await a.library();
  await lib.getByTestId('library-item').click();
  await lib.getByRole('textbox', { name: 'Your question' }).fill('Where does it come from?');
  await lib.getByTestId('library-chat-send').click();
  await expect(lib.getByRole('log', { name: 'Chat about townspeople' })).toContainText(
    'It comes from Greek.',
  );
  await lib.close();

  const aOptions = await a.options();
  await syncNow(aOptions);
  await expect
    .poll(
      async () =>
        (
          await stack.sql<{ n: string }>(
            `SELECT count(*) AS n FROM word_chat_messages m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
            [ALICE],
          )
        )[0]?.n,
      { timeout: 30_000 },
    )
    .toBe('2');

  const bOptions = await b.options();
  await syncNow(bOptions);
  await expect.poll(() => libraryWords(b), { timeout: 30_000 }).toEqual(['townspeople']);
  const bLib = await b.library();
  await bLib.getByTestId('library-item').click();
  const log = bLib.getByRole('log', { name: 'Chat about townspeople' });
  await expect(log).toContainText('Where does it come from?');
  await expect(log).toContainText('It comes from Greek.');
  await bLib.close();
  await aOptions.close();
  await bOptions.close();
});

test("5. a second user does not see the first user's words", async () => {
  const options = await signIn(c, CAROL);
  await syncNow(options);
  expect(await libraryWords(c)).toEqual([]);

  await c.saveWord('neighbours');
  await syncNow(options);
  await expect.poll(() => liveServerWords(CAROL), { timeout: 30_000 }).toEqual(['neighbours']);
  expect(await liveServerWords(ALICE)).toEqual(['townspeople']);

  // Alice's devices never receive Carol's word.
  const aOptions = await a.options();
  await syncNow(aOptions);
  expect(await libraryWords(a)).toEqual(['townspeople']);
  expect(await libraryWords(c)).toEqual(['neighbours']);
  await options.close();
  await aOptions.close();
});

test('4a. signing out without "Keep a copy" clears the local data', async () => {
  const options = await b.options();
  await options.getByTestId('account-sign-out').click();
  await expect(options.getByTestId('account-keep-copy')).not.toBeChecked();
  await options.waitForTimeout(600);
  await options.getByTestId('account-dialog-confirm').click();
  await expect(options.getByTestId('account-sign-in')).toBeVisible({ timeout: 30_000 });

  expect(await libraryWords(b)).toEqual([]);
  const stores = await dumpDb(options);
  expect(stores['words']).toEqual([]);
  expect(stores['chat']).toEqual([]);
  // The account's data stays on the server.
  expect(await liveServerWords(ALICE)).toEqual(['townspeople']);
  await options.close();
});

test('4b. signing out with "Keep a copy" keeps the data on the device', async () => {
  const options = await a.options();
  await options.getByTestId('account-sign-out').click();
  await options.getByTestId('account-keep-copy').check();
  await options.waitForTimeout(600);
  await options.getByTestId('account-dialog-confirm').click();
  await expect(options.getByTestId('account-sign-in')).toBeVisible({ timeout: 30_000 });

  expect(await libraryWords(a)).toEqual(['townspeople']);
  const stores = await dumpDb(options);
  expect(stores['words']).toHaveLength(1);
  expect(stores['chat']).toHaveLength(2);
  expect(await liveServerWords(ALICE)).toEqual(['townspeople']);
  await options.close();
});
