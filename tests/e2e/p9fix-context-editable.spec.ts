import { expect, test } from '@playwright/test';
import { dblclickText } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { CARD, cardOf, startCardHarness, type CardHarness } from './p5-card-support/harness';

// Phase 9 audit M1: text the user is typing (contenteditable, role=textbox, designMode) is never
// sent to Groq, neither as the selection nor as the text around it. Built extension, fake Groq.
const FIXTURE = 'p9fix-editable.html';
const DRAFTS = [
  'DRAFT-CONTENTEDITABLE-SECRET',
  'DRAFT-ROLE-TEXTBOX-SECRET',
  'DRAFT-PLAINTEXT-SECRET',
];

let h: CardHarness;
test.beforeAll(async () => {
  h = await startCardHarness();
});
test.afterAll(async () => {
  await h?.close();
});
test.beforeEach(() => {
  h.groq.reset();
});

test('a word next to editable drafts: the request carries the readable context and no draft', async () => {
  const { page, dispose } = await h.open(FIXTURE);
  await dblclickText(page, page, 'cartographer');
  await tb(page).waitShown();
  await tb(page).click('explain');
  await cardOf(page).waitFor(CARD.ready('core'));
  const user = h.groq.chats()[0]?.body?.messages[1]?.content ?? '';
  expect(user).toContain('cartographer');
  // Text before and after the selection is still sent where it is readable page text ...
  expect(user).toContain('replied to the thread');
  expect(user).toContain('Visible tail of the sentence.');
  // ... but nothing the user types, in any editable form.
  for (const draft of DRAFTS) expect(user).not.toContain(draft);
  await dispose();
});

test('a selection inside a role=textbox element gets no toolbar and sends nothing', async () => {
  const { page, dispose } = await h.open(FIXTURE);
  await dblclickText(page, page, 'composer');
  await page.waitForTimeout(600);
  expect(await tb(page).isShown()).toBe(false);
  await dblclickText(page, page, 'DRAFT-ROLE-TEXTBOX-SECRET');
  await page.waitForTimeout(600);
  expect(await tb(page).isShown()).toBe(false);
  expect(h.groq.chats()).toHaveLength(0);
  await dispose();
});

test('a document in designMode gets no toolbar and sends nothing', async () => {
  const { page, dispose } = await h.open(FIXTURE);
  await page.evaluate(() => {
    document.designMode = 'on';
  });
  await dblclickText(page, page, 'cartographer');
  await page.waitForTimeout(600);
  expect(await tb(page).isShown()).toBe(false);
  expect(h.groq.chats()).toHaveLength(0);
  await dispose();
});
