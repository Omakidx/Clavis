import { describe, expect, it } from 'vitest';
import { classifySender, type SenderLike } from '../../../lib/router/sender';
import { senderAllowed, type Route } from '../../../lib/router/router';
import {
  ORIGIN,
  RUNTIME_ID,
  contentSender,
  createHarness,
  offscreenSender,
  pageSender,
  panelSender,
  popupSender,
} from '../router/harness';

// Phase 9, "chrome.runtime message integration tests and secret-boundary checks" (FR-070, abuse
// cases 1, 8; architecture section 9 rule 4). The router tests prove behaviours for chosen
// messages; this file proves the WHOLE ROUTE TABLE against the policy, so that a route added or
// loosened later fails here until the policy (written below, independently of routes.ts) is
// consciously changed. Every (route, sender) pair of the real table is evaluated with the real
// sender classifier; nothing is mocked but the browser.

const identity = { runtimeId: RUNTIME_ID, extensionOrigin: ORIGIN };
const h = createHarness();

const KEY_ROUTES = [
  'SET_API_KEY',
  'TEST_API_KEY',
  'REMOVE_API_KEY',
  'GET_KEY_STATUS',
  'CLEAR_ALL_DATA',
] as const;
const SETTINGS_ROUTES = [
  'GET_SETTINGS',
  'UPDATE_PREFERENCES',
  'RESET_PREFERENCES',
  'ACCEPT_DISCLOSURE',
  'UPDATE_ONBOARDING',
  'GET_SITE_ACCESS_STATUS',
  'GET_VOICES',
] as const;
const INTERNAL_ROUTES = ['CLAVIS_INJECT_TAB'] as const;
/** What a content script (next to a hostile page) may ever ask: nothing that returns or changes the key. */
const CONTENT_ROUTES = [
  'AI_EXPLAIN',
  'AI_CANCEL',
  'TTS_SPEAK',
  'TTS_STOP',
  'GET_PUBLIC_SETTINGS',
  'GET_AI_STATUS',
  'LOAD_EXPLAIN_CARD',
  'LOAD_TOOLBAR',
  'OPEN_SETTINGS',
  'OPEN_SIDE_PANEL',
] as const;
const PANEL_ROUTES = ['GET_SIDE_PANEL_STATE'] as const;

const CLASSIFIED = new Set<string>([
  ...KEY_ROUTES,
  ...SETTINGS_ROUTES,
  ...INTERNAL_ROUTES,
  ...CONTENT_ROUTES,
  ...PANEL_ROUTES,
]);

const SENDERS: Record<string, SenderLike> = {
  content: contentSender(),
  'content (iframe of a web page)': { ...contentSender(), frameId: 4 },
  'content (about:blank frame of a web page)': {
    id: RUNTIME_ID,
    url: 'about:blank',
    origin: 'https://example.com',
    frameId: 2,
    tab: { id: 5, url: 'https://example.com/' },
  },
  options: pageSender('/options.html'),
  onboarding: pageSender('/onboarding.html'),
  popup: popupSender(),
  reader: pageSender('/reader.html'),
  practice: pageSender('/practice.html'),
  sidepanel: panelSender(5),
  'an extension page that is not ours to trust (removed offscreen page)': offscreenSender(),
  'another extension': {
    id: 'someoneelseabcdefghijklmnopqrstu',
    url: 'chrome-extension://someoneelseabcdefghijklmnopqrstu/options.html',
    frameId: 0,
    tab: { id: 6, url: 'chrome-extension://someoneelseabcdefghijklmnopqrstu/options.html' },
  },
  'our Settings page framed inside a website': {
    id: RUNTIME_ID,
    url: `${ORIGIN}/options.html`,
    frameId: 3,
    tab: { id: 7, url: 'https://evil.example/' },
  },
  'our Settings page as a sub-frame of one of our pages': {
    ...pageSender('/options.html'),
    frameId: 2,
  },
  'a sender with no fields at all': {},
};

/** The routes of the REAL table that `sender` may call, per the real classifier and rules. */
function allowedFor(sender: SenderLike, routes: readonly Route[] = h.routes): string[] {
  const classified = classifySender(sender, identity);
  return routes.filter((r) => senderAllowed(r.allow, classified)).map((r) => r.type);
}

describe('the route table, against the policy', () => {
  it('every route in the table is classified here (a new route must be added to the policy on purpose)', () => {
    const types = h.routes.map((r) => r.type);
    expect(types.filter((t) => !CLASSIFIED.has(t))).toEqual([]);
    // ...and the policy names no route that no longer exists.
    expect([...CLASSIFIED].filter((t) => !types.includes(t))).toEqual([]);
    expect(new Set(types).size).toBe(types.length);
  });

  it('a website content script (in any frame) may call only the declared content routes and never a key, settings, voice, site-access, inject or panel-state route', () => {
    for (const name of [
      'content',
      'content (iframe of a web page)',
      'content (about:blank frame of a web page)',
    ]) {
      const allowed = allowedFor(SENDERS[name]!);
      expect(
        allowed.filter((t) => !(CONTENT_ROUTES as readonly string[]).includes(t)),
        name,
      ).toEqual([]);
      for (const privileged of [
        ...KEY_ROUTES,
        ...SETTINGS_ROUTES,
        ...INTERNAL_ROUTES,
        ...PANEL_ROUTES,
      ]) {
        expect(allowed, `${name} must not reach ${privileged}`).not.toContain(privileged);
      }
    }
  });

  it('only Settings and the welcome page reach the key routes; the reader (untrusted PDFs), practice page, popup, panel and everything else never do', () => {
    for (const [name, sender] of Object.entries(SENDERS)) {
      const allowed = allowedFor(sender);
      const keyRoutes = allowed.filter((t) => (KEY_ROUTES as readonly string[]).includes(t));
      if (name === 'options' || name === 'onboarding') {
        expect([...keyRoutes].sort(), name).toEqual([...KEY_ROUTES].sort());
      } else {
        expect(keyRoutes, `${name} must reach no key route`).toEqual([]);
      }
    }
  });

  it('the reader and the practice page, which render untrusted content, reach no settings, voice-list, site-access or inject route', () => {
    for (const name of ['reader', 'practice']) {
      const allowed = allowedFor(SENDERS[name]!);
      for (const route of [...KEY_ROUTES, ...SETTINGS_ROUTES, ...INTERNAL_ROUTES]) {
        expect(allowed, `${name} must not reach ${route}`).not.toContain(route);
      }
      // They host the card, so they do reach the card routes.
      for (const route of ['AI_EXPLAIN', 'AI_CANCEL', 'OPEN_SIDE_PANEL', 'OPEN_SETTINGS']) {
        expect(allowed, `${name} should reach ${route}`).toContain(route);
      }
    }
  });

  it('the popup reads settings and status, can inject into a tab, and cannot touch the key', () => {
    const allowed = allowedFor(SENDERS['popup']!);
    expect(allowed).toContain('CLAVIS_INJECT_TAB');
    expect(allowed).toContain('GET_SETTINGS');
    for (const route of KEY_ROUTES) expect(allowed).not.toContain(route);
    // CLAVIS_INJECT_TAB can script any granted tab: the popup alone.
    for (const [name, sender] of Object.entries(SENDERS)) {
      if (name === 'popup') continue;
      expect(allowedFor(sender), name).not.toContain('CLAVIS_INJECT_TAB');
    }
  });

  it('the side panel may only explain, speak, read public settings, open Settings and read its own tab', () => {
    const allowed = allowedFor(SENDERS['sidepanel']!);
    const permitted = [
      'AI_EXPLAIN',
      'AI_CANCEL',
      'TTS_SPEAK',
      'TTS_STOP',
      'GET_PUBLIC_SETTINGS',
      'OPEN_SETTINGS',
      'GET_SIDE_PANEL_STATE',
    ];
    expect(allowed.filter((t) => !permitted.includes(t))).toEqual([]);
    expect(allowed).toContain('GET_SIDE_PANEL_STATE');
  });

  it('only the card hosts reach OPEN_SIDE_PANEL, only a content script loads the card, only the panel reads a hand-off', () => {
    for (const [name, sender] of Object.entries(SENDERS)) {
      const allowed = allowedFor(sender);
      const cardHost = [
        'content',
        'content (iframe of a web page)',
        'content (about:blank frame of a web page)',
        'reader',
        'practice',
      ].includes(name);
      expect(allowed.includes('OPEN_SIDE_PANEL'), `OPEN_SIDE_PANEL for ${name}`).toBe(cardHost);
      expect(allowed.includes('LOAD_EXPLAIN_CARD'), `LOAD_EXPLAIN_CARD for ${name}`).toBe(
        name.startsWith('content'),
      );
      expect(allowed.includes('GET_SIDE_PANEL_STATE'), `GET_SIDE_PANEL_STATE for ${name}`).toBe(
        name === 'sidepanel',
      );
    }
  });

  it('nothing else is trusted: a foreign extension, a framed Settings page, an unknown page and an empty sender reach nothing', () => {
    for (const name of [
      'an extension page that is not ours to trust (removed offscreen page)',
      'another extension',
      'our Settings page framed inside a website',
      'our Settings page as a sub-frame of one of our pages',
      'a sender with no fields at all',
    ]) {
      expect(allowedFor(SENDERS[name]!), name).toEqual([]);
    }
  });

  it('every route has a non-empty rule that names someone (no route is open to all)', () => {
    for (const route of h.routes) {
      const rule = route.allow;
      expect(rule.content === true || (rule.pages?.length ?? 0) > 0, route.type).toBe(true);
      // The rule can only list our own pages: a path outside the known set would be dead or wrong.
      for (const path of rule.pages ?? []) {
        expect(
          [
            '/options.html',
            '/onboarding.html',
            '/popup.html',
            '/reader.html',
            '/practice.html',
            '/sidepanel.html',
          ],
          `${route.type} lists ${path}`,
        ).toContain(path);
      }
    }
  });
});

describe('self-check: the policy predicates catch a loosened table', () => {
  it('a key route opened to content scripts, and a new unclassified route, are both found', () => {
    const loosened = h.routes.map((r) =>
      r.type === 'GET_KEY_STATUS' ? ({ ...r, allow: { content: true } } as Route) : r,
    );
    const outside = allowedFor(SENDERS['content']!, loosened).filter(
      (t) => !(CONTENT_ROUTES as readonly string[]).includes(t),
    );
    expect(outside).toEqual(['GET_KEY_STATUS']);

    const withNew = [...h.routes, { ...h.routes[0]!, type: 'GET_API_KEY' } as Route];
    expect(withNew.map((r) => r.type).filter((t) => !CLASSIFIED.has(t))).toEqual(['GET_API_KEY']);
  });
});
