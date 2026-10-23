// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { confirmingLinkService, toSafeExternalUrl } from '../../../lib/pdf/links';

class BaseService {
  addLinkAttributes(link: HTMLAnchorElement, url: string): void {
    // What PDF.js's own implementation does: make the link navigate.
    link.href = url;
    link.target = '_blank';
  }
}

function setup(confirm = vi.fn(async () => true)) {
  const open = vi.fn();
  const Service = confirmingLinkService(BaseService, confirm, open);
  const service = new Service();
  const link = (url: string) => {
    const a = document.createElement('a');
    service.addLinkAttributes(a, url);
    return a;
  };
  const click = (a: HTMLAnchorElement): MouseEvent => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    return event;
  };
  return { link, click, confirm, open };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('confirmingLinkService (PDF links)', () => {
  it('never lets PDF.js navigate: href is "#" and there is no target', () => {
    const { link } = setup();
    for (const url of ['https://example.com/', 'javascript:alert(1)', 'file:///etc/passwd']) {
      const a = link(url);
      expect(a.getAttribute('href')).toBe('#');
      expect(a.hasAttribute('target')).toBe(false);
      expect(a.rel).toContain('noopener');
    }
  });

  it.each([
    'javascript:window.__pwned=1',
    'JaVaScRiPt:alert(1)',
    'file:///etc/passwd',
    'chrome://settings',
    'chrome-extension://abc/options.html',
    'data:text/html,<script>1</script>',
    'blob:https://example.com/uuid',
    'vbscript:msgbox(1)',
    '/relative/path',
    '//example.com/protocol-relative',
    '',
  ])('does nothing for %j: no title, no confirmation, nothing opened', async (url) => {
    const { link, click, confirm, open } = setup();
    const a = link(url);
    expect(a.title).toBe('');
    const event = click(a);
    await flush();
    // `href="#"` must not navigate either: the handler cancels the click.
    expect(event.defaultPrevented).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('asks before opening an http(s) link and opens it only after a yes', async () => {
    const yes = setup(vi.fn(async () => true));
    const a = yes.link('https://example.com/page?x=1');
    expect(a.title).toBe('https://example.com/page?x=1');
    const event = yes.click(a);
    expect(event.defaultPrevented).toBe(true);
    expect(yes.confirm).toHaveBeenCalledExactlyOnceWith('https://example.com/page?x=1');
    expect(yes.open).not.toHaveBeenCalled(); // not before the answer
    await flush();
    expect(yes.open).toHaveBeenCalledExactlyOnceWith('https://example.com/page?x=1');

    const no = setup(vi.fn(async () => false));
    no.click(no.link('https://example.com/'));
    await flush();
    expect(no.open).not.toHaveBeenCalled();
  });

  it('allows mailto: and strips credentials from what is shown and opened', async () => {
    const s = setup();
    const mail = s.link('mailto:someone@example.com');
    expect(mail.title).toBe('mailto:someone@example.com');
    const creds = s.link('https://user:secret@example.com/x');
    expect(creds.title).toBe('https://example.com/x');
    s.click(creds);
    await flush();
    expect(s.open).toHaveBeenCalledWith('https://example.com/x');
    expect(JSON.stringify(s.confirm.mock.calls)).not.toContain('secret');
  });
});

describe('double clicks on a link', () => {
  it('only the first click of a multi-click asks; the rest does nothing and opens nothing', async () => {
    const { link, confirm, open } = setup();
    const a = link('https://example.com/');
    for (const detail of [1, 2, 3]) {
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
    }
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('mailto links (LOW-4)', () => {
  it('keeps the address and only subject, body, cc and bcc', () => {
    const url = toSafeExternalUrl(
      'mailto:a@example.com,b@example.com?Subject=Hi%20there&body=Line&attach=/etc/passwd&cc=c@example.com&bcc=d@example.com&x-foo=1#frag',
    );
    expect(url?.href).toBe(
      'mailto:a@example.com,b@example.com?subject=Hi%20there&body=Line&cc=c%40example.com&bcc=d%40example.com',
    );
  });

  it('drops attach and everything else, leaving a bare address', () => {
    expect(toSafeExternalUrl('mailto:someone@example.com?attach=/etc/passwd')?.href).toBe(
      'mailto:someone@example.com',
    );
    expect(
      toSafeExternalUrl('mailto:someone@example.com?attachment=%2Fhome%2Fme%2Fkey&ATTACH=x')?.href,
    ).toBe('mailto:someone@example.com');
  });

  it('shows and opens the sanitized address', async () => {
    const s = setup();
    const a = s.link('mailto:someone@example.com?subject=Hello&attach=/etc/passwd');
    expect(a.title).toBe('mailto:someone@example.com?subject=Hello');
    s.click(a);
    await flush();
    expect(s.confirm).toHaveBeenCalledExactlyOnceWith('mailto:someone@example.com?subject=Hello');
    expect(s.open).toHaveBeenCalledExactlyOnceWith('mailto:someone@example.com?subject=Hello');
  });
});

describe('toSafeExternalUrl', () => {
  it('only http, https and mailto', () => {
    expect(toSafeExternalUrl('ftp://example.com/')).toBeNull();
    expect(toSafeExternalUrl('tel:+123')).toBeNull();
    expect(toSafeExternalUrl('http://example.com')?.protocol).toBe('http:');
  });
});
