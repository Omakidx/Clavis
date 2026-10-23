import { expect, test, type BrowserContext } from '@playwright/test';
import { send } from './p3-support/background';
import { openExtensionPage } from './p3-ui-support/pages';
import { CARD, chatBody, overrideChat, type CardProbe } from './p5-card-support/harness';
import { ACCEPT_KEY, startWorld, type World } from './p8-accept-support/world';
import { setUpKey } from './p8-accept-support/setup';
import { SURFACES, openSurface, type SurfaceName } from './p8-accept-support/surfaces';

// Phase 8, "Add Copy answer, dismiss, retry, provider status, and clear no-key prompts ... same
// card in webpage, practice page and reader" (FR-039, FR-072, UJ-05, error catalog in
// requirements.md section 7). Every provider state is produced for each of the three surfaces and
// the card's wording and behaviour must be the same on all three, and match the catalog.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

type Scenario = 'ok' | 'offline' | 'garbage';
const behaviour: { current: Scenario } = { current: 'ok' };
let world: World;

test.beforeAll(async () => {
  world = await startWorld({ granted: true });
  await setUpKey(world);
  await overrideChat(world.ext.context, async (route) => {
    if (behaviour.current === 'offline') return route.abort('internetdisconnected');
    if (behaviour.current === 'garbage') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: chatBody('this is not json'),
      });
    }
    return route.fallback();
  });
});
test.afterAll(async () => {
  await world?.close();
});

test.afterEach(async () => {
  // A 401 flags the stored key as rejected (FR-072); store it again so each test starts valid.
  world.groq.chatStatus.current = undefined;
  delete world.groq.chatStatus.retryAfter;
  behaviour.current = 'ok';
  await world.ext.context.setOffline(false);
  const { page } = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  await send(page, { v: 1, type: 'SET_API_KEY', apiKey: ACCEPT_KEY, storage: 'local' });
  await page.close();
});

interface Shape {
  code: string | null;
  offline: string | null;
  paragraphs: string[];
  buttons: { label: string; inactive: string | null }[];
  /** What a screen reader gets: the error sits in a card whose live region and roles are the same. */
  hasLive: boolean;
}

async function shapeOf(card: CardProbe): Promise<Shape> {
  const shape = await card.toolbar.evalIn<Shape>(
    CARD.error,
    `function () {
      return {
        code: this.getAttribute('data-code'),
        offline: this.getAttribute('data-offline'),
        paragraphs: Array.from(this.querySelectorAll('p')).map((p) => p.textContent),
        buttons: Array.from(this.querySelectorAll('button')).map((b) => ({
          label: b.textContent, inactive: b.getAttribute('aria-disabled'),
        })),
        hasLive: this.closest('[data-clavis="card"]').querySelector('[role="status"]') !== null,
      };
    }`,
  );
  if (shape === undefined) throw new Error('no error shown');
  return shape;
}

/** What a person sees of the card: its type, colours and the primary button, as computed styles. */
async function lookOf(card: CardProbe): Promise<Record<string, string>> {
  const look = await card.toolbar.evalIn<Record<string, string>>(
    '[data-clavis="card"]',
    `function () {
      const c = getComputedStyle(this);
      const e = getComputedStyle(this.querySelector('[data-clavis="card-error"]'));
      const b = getComputedStyle(this.querySelector('[data-clavis="card-error"] button'));
      const pick = (s, keys) => Object.fromEntries(keys.map((k) => [k, s[k]]));
      return {
        ...pick(c, ['fontFamily', 'fontSize', 'color', 'backgroundColor', 'borderRadius']),
        error: JSON.stringify(pick(e, ['fontSize', 'color', 'backgroundColor', 'borderColor'])),
        button: JSON.stringify(pick(b, ['fontSize', 'color', 'backgroundColor', 'borderRadius', 'minHeight'])),
      };
    }`,
  );
  return look ?? {};
}

/** Run `scenario` once per surface and return what each one showed. */
async function onEverySurface<T>(
  run: (
    name: SurfaceName,
    card: CardProbe,
    surface: Awaited<ReturnType<typeof openSurface>>,
  ) => Promise<T>,
): Promise<Record<SurfaceName, T>> {
  const out = {} as Record<SurfaceName, T>;
  for (const name of SURFACES) {
    const surface = await openSurface(world, name);
    try {
      const card = await surface.explain();
      out[name] = await run(name, card, surface);
    } finally {
      await surface.dispose();
    }
  }
  return out;
}

const sameOnAll = (results: Record<SurfaceName, unknown>): void => {
  expect(results.practice, 'practice page vs web page').toEqual(results.webpage);
  expect(results.reader, 'PDF reader vs web page').toEqual(results.webpage);
};

async function settingsOpenedBy(
  context: BrowserContext,
  card: CardProbe,
  hash: string,
): Promise<void> {
  const opened = context.waitForEvent('page');
  await card.click(CARD.settings);
  const settings = await opened;
  await settings.waitForURL(new RegExp(`/options\\.html#${hash}$`));
  await expect(settings.getByRole('region', { name: /./ }).first()).toBeAttached();
  await settings.close();
}

test('401 invalid key: the same message and "Update key" on all surfaces; the button opens Settings at the key', async () => {
  world.groq.chatStatus.current = 401;
  const shapes = await onEverySurface(async (_name, card, surface) => {
    await card.waitFor(CARD.error);
    const shape = { ...(await shapeOf(card)), look: await lookOf(card) };
    await surface.page.bringToFront();
    await settingsOpenedBy(world.ext.context, card, 'section-key');
    // The stored key is flagged; put it back so the next surface asks Groq again.
    const { page } = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
    await send(page, { v: 1, type: 'SET_API_KEY', apiKey: ACCEPT_KEY, storage: 'local' });
    await page.close();
    return shape;
  });
  sameOnAll(shapes);
  expect(shapes.webpage.code).toBe('INVALID_API_KEY');
  expect(shapes.webpage.paragraphs.join(' ')).toContain("Groq didn't accept your key.");
  expect(shapes.webpage.buttons).toEqual([{ label: 'Update key', inactive: null }]);
});

test('model unavailable (404): "Choose another model" on all surfaces opens Settings at the model section', async () => {
  world.groq.chatStatus.current = 404;
  const shapes = await onEverySurface(async (_name, card, surface) => {
    await card.waitFor(CARD.error);
    const shape = await shapeOf(card);
    await surface.page.bringToFront();
    await settingsOpenedBy(world.ext.context, card, 'section-model');
    return shape;
  });
  sameOnAll(shapes);
  expect(shapes.webpage.code).toBe('MODEL_UNAVAILABLE');
  expect(shapes.webpage.paragraphs.join(' ')).toContain("The chosen model isn't available");
  expect(shapes.webpage.buttons).toEqual([{ label: 'Choose another model', inactive: null }]);
});

test('429: "Rate limit reached", a countdown that holds Try again inactive, no request loop, same on all surfaces', async () => {
  world.groq.chatStatus.current = 429;
  world.groq.chatStatus.retryAfter = '3';
  const shapes = await onEverySurface(async (_name, card) => {
    await card.waitFor(CARD.error);
    const shape = await shapeOf(card);
    const sent = world.groq.chats().length;
    // While the countdown runs the button is inactive and a click sends nothing.
    expect(shape.buttons).toHaveLength(1);
    expect(shape.buttons[0]?.label).toMatch(/^Try again in [123] s$/);
    expect(shape.buttons[0]?.inactive).toBe('true');
    await card.click(CARD.retry);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(world.groq.chats().length).toBe(sent);
    // When it is over the label says so (and the live region announces it); Groq is not asked
    // again until the person presses it (no automatic loop, FR-039 / NFR retry rules).
    await expect.poll(() => card.text(CARD.retry), { timeout: 8000 }).toBe('Try again');
    expect(await card.text(CARD.live)).toBe('You can try again now.');
    expect(world.groq.chats().length).toBe(sent);
    // Normalise the countdown digit so the surfaces can be compared.
    return {
      ...shape,
      buttons: shape.buttons.map((b) => ({ ...b, label: b.label.replace(/\d+/, 'N') })),
    };
  });
  sameOnAll(shapes);
  expect(shapes.webpage.code).toBe('RATE_LIMITED');
  expect(shapes.webpage.paragraphs[0]).toBe('Rate limit reached');
});

test('offline: says the computer is offline and offers Try again, which recovers; same on all surfaces', async () => {
  behaviour.current = 'offline';
  const shapes = await onEverySurface(async (name, card, surface) => {
    await card.waitFor(CARD.error, 20_000);
    // The wording follows what the browser knows. Make it know (Playwright's offline switch) and
    // load the card again so it re-words the same error.
    await world.ext.context.setOffline(true);
    await surface.page.evaluate(() => window.dispatchEvent(new Event('offline')));
    if (surface.target !== surface.page) {
      await (surface.target as import('@playwright/test').Frame).evaluate(() =>
        window.dispatchEvent(new Event('offline')),
      );
    }
    await expect
      .poll(() => card.toolbar.attr(CARD.error, 'data-offline'), { message: name })
      .toBe('true');
    const shape = await shapeOf(card);
    await world.ext.context.setOffline(false);
    behaviour.current = 'ok';
    await card.click(CARD.retry);
    await card.waitFor(CARD.ready('core'));
    behaviour.current = 'offline';
    return shape;
  });
  sameOnAll(shapes);
  expect(shapes.webpage.paragraphs[0]).toBe("You're offline");
  expect(shapes.webpage.paragraphs[1]).toContain('offline');
  expect(shapes.webpage.buttons).toEqual([{ label: 'Try again', inactive: null }]);
});

test('a connection failure while the browser says it is online: "Can\'t connect" (error catalog) and Try again, same on all surfaces', async () => {
  behaviour.current = 'offline';
  const shapes = await onEverySurface(async (_name, card) => {
    await card.waitFor(CARD.error, 20_000);
    return shapeOf(card);
  });
  sameOnAll(shapes);
  expect(shapes.webpage.paragraphs[0]).toBe("Can't connect");
  expect(shapes.webpage.buttons).toEqual([{ label: 'Try again', inactive: null }]);
});

test('an answer that cannot be read: "Couldn\'t format explanation" with Try again, same on all surfaces', async () => {
  behaviour.current = 'garbage';
  const shapes = await onEverySurface(async (_name, card) => {
    await card.waitFor(CARD.error, 20_000);
    return shapeOf(card);
  });
  sameOnAll(shapes);
  expect(shapes.webpage.paragraphs[0]).toBe("Couldn't format explanation");
  expect(shapes.webpage.buttons).toEqual([{ label: 'Try again', inactive: null }]);
});

test('no key: "Connect Groq" on all surfaces opens Settings at the key section; nothing is sent', async () => {
  // A person who skipped setup: no key, nothing acknowledged.
  const { page } = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  await send(page, { v: 1, type: 'REMOVE_API_KEY' });
  await page.close();
  world.groqUrls.length = 0;
  const shapes = await onEverySurface(async (_name, card, surface) => {
    await card.waitFor(CARD.error);
    const shape = await shapeOf(card);
    await surface.page.bringToFront();
    await settingsOpenedBy(world.ext.context, card, 'section-key');
    return shape;
  });
  sameOnAll(shapes);
  expect(shapes.webpage.code).toBe('SETUP_REQUIRED');
  expect(shapes.webpage.paragraphs.join(' ')).toContain('Connect your Groq key to use Explain.');
  expect(shapes.webpage.buttons).toEqual([{ label: 'Connect Groq', inactive: null }]);
  expect(world.groqUrls.filter((u) => u.endsWith('/chat/completions'))).toEqual([]);
});
