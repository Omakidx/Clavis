import { describe, expect, it } from 'vitest';
import { classifySender } from '../../../lib/router/sender';
import {
  ORIGIN,
  RUNTIME_ID,
  contentSender,
  offscreenSender,
  pageSender,
  popupSender,
} from './harness';

const identity = { runtimeId: RUNTIME_ID, extensionOrigin: `${ORIGIN}/` };
const classify = (sender: object) => classifySender(sender, identity);

describe('classifySender', () => {
  it('recognises a website content script with its tab and frame', () => {
    expect(classify({ ...contentSender(5), frameId: 3 })).toMatchObject({
      kind: 'content',
      tabId: 5,
      frameId: 3,
    });
  });

  it.each(['/options.html', '/onboarding.html', '/popup.html', '/reader.html', '/practice.html'])(
    'recognises %s by exact path',
    (path) => {
      expect(classify(pageSender(path))).toMatchObject({ kind: 'extension', path });
    },
  );

  it('recognises the popup without a tab', () => {
    const result = classify(popupSender());
    expect(result).toMatchObject({ kind: 'extension', path: '/popup.html' });
    expect(result.tabId).toBeUndefined();
  });

  it('recognises the offscreen document, which must have no tab', () => {
    expect(classify(offscreenSender())).toMatchObject({ kind: 'offscreen' });
    expect(
      classify({ ...offscreenSender(), tab: { id: 1, url: `${ORIGIN}/offscreen.html` } }).kind,
    ).toBe('unknown');
  });

  it('treats everything else as unknown', () => {
    for (const sender of [
      {},
      { id: RUNTIME_ID },
      { id: RUNTIME_ID, url: 'not a url', tab: { id: 1 } },
      { id: 'other', url: `${ORIGIN}/options.html` },
      { id: RUNTIME_ID, url: `${ORIGIN}/unlisted.html` },
      { id: RUNTIME_ID, url: 'https://example.com/' }, // a web page without a tab is not a content script
      { id: RUNTIME_ID, url: 'chrome://settings', tab: { id: 1 } },
      { id: RUNTIME_ID, url: 'blob:https://example.com/uuid', tab: { id: 1 } },
      contentSender(undefined as never, 'file:///a.html'),
    ]) {
      expect(classify(sender).kind, JSON.stringify(sender)).toBe('unknown');
    }
    expect(classifySender(null as never, identity).kind).toBe('unknown');
  });

  it('refuses an extension page whose tab is a website (embedded in a frame)', () => {
    expect(
      classify({
        id: RUNTIME_ID,
        url: `${ORIGIN}/popup.html`,
        frameId: 2,
        tab: { id: 4, url: 'https://evil.example/' },
      }).kind,
    ).toBe('unknown');
  });

  it('is not fooled by a look-alike host', () => {
    expect(classify({ id: RUNTIME_ID, url: `${ORIGIN}x/options.html`, tab: { id: 1 } }).kind).toBe(
      'unknown',
    );
    expect(
      classify({ id: RUNTIME_ID, url: `chrome-extension://other/options.html`, tab: { id: 1 } })
        .kind,
    ).toBe('unknown');
  });

  it('trusts an extension page only as a top frame (a frame of /options.html in another page is not options)', () => {
    const framed = {
      id: RUNTIME_ID,
      url: `${ORIGIN}/options.html`,
      frameId: 4,
      tab: { id: 9, url: `${ORIGIN}/reader.html` },
    };
    expect(classify(framed).kind).toBe('unknown');
    expect(classify({ ...framed, frameId: 0 }).kind).toBe('extension');
    expect(classify({ ...framed, frameId: undefined }).kind).toBe('unknown');
    expect(classify({ ...popupSender(), frameId: 1 }).kind).toBe('unknown');
  });

  it('trusts the real toolbar popup, which has no tab and no frameId (regression)', () => {
    expect(classify(popupSender())).toMatchObject({ kind: 'extension', path: '/popup.html' });
    expect(classify({ ...popupSender(), frameId: 0 }).kind).toBe('extension');
    // Only the popup may be tab-less; any other page without a tab is not trusted.
    expect(classify({ id: RUNTIME_ID, url: `${ORIGIN}/options.html` }).kind).toBe('unknown');
    expect(classify({ id: RUNTIME_ID, url: `${ORIGIN}/reader.html` }).kind).toBe('unknown');
    // A page opened in a tab still has to report frame 0.
    expect(
      classify({
        id: RUNTIME_ID,
        url: `${ORIGIN}/popup.html`,
        tab: { id: 2, url: `${ORIGIN}/popup.html` },
      }).kind,
    ).toBe('unknown');
  });

  it('does not take an about:blank / srcdoc frame inside our own page for a content script', () => {
    for (const url of ['about:blank', 'about:srcdoc']) {
      const insideOurPage = {
        id: RUNTIME_ID,
        url,
        origin: ORIGIN,
        frameId: 2,
        tab: { id: 3, url: `${ORIGIN}/practice.html` },
      };
      expect(classify(insideOurPage).kind, url).toBe('unknown');
      // The same frame in a website is a content script (matchOriginAsFallback).
      expect(
        classify({
          ...insideOurPage,
          origin: 'https://example.com',
          tab: { id: 3, url: 'https://example.com/' },
        }).kind,
        url,
      ).toBe('content');
    }
    // A sandboxed frame has an opaque origin ("null"), which is not ours either.
    expect(
      classify({ id: RUNTIME_ID, url: 'about:srcdoc', origin: 'null', frameId: 1, tab: { id: 3 } })
        .kind,
    ).toBe('content');
  });
});
