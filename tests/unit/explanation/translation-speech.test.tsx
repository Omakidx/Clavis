// @vitest-environment jsdom
/** @jsxImportSource preact */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationSpeech } from '../../../components/explanation/TranslationSpeech';
import type { CardHost } from '../../../components/explanation/ExplanationCard';
import type { ListenReport } from '../../../lib/selection/ui-api';
import * as trust from '../../../lib/selection/trust';
import { installCatalog } from './support';

let root: HTMLElement;
let update: (report: ListenReport) => void;
const stop = vi.fn();
const speak = vi.fn(
  (_text: string, _lang: string | undefined, report: (value: ListenReport) => void) => {
    update = report;
    return stop;
  },
);
const host = { speak } as unknown as CardHost;

beforeEach(() => {
  installCatalog();
  vi.clearAllMocks();
  vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(true);
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  act(() => render(null, root));
  root.remove();
});

async function mount() {
  await act(() => render(<TranslationSpeech text="banque" lang="fr" host={host} />, root));
}
async function click() {
  await act(() => root.querySelector('button')!.click());
}

describe('translation pronunciation', () => {
  it('only starts on a trusted click and speaks the translated output with its target language', async () => {
    await mount();
    expect(speak).not.toHaveBeenCalled();
    expect(root.querySelector('button')?.getAttribute('aria-label')).toBe('Listen to translation');
    await click();
    expect(speak).toHaveBeenCalledWith('banque', 'fr', expect.any(Function));
    // A click alone does not pretend audio has started.
    expect(root.querySelector('button')?.getAttribute('aria-pressed')).toBe('false');
    await act(() => update({ status: 'starting' }));
    expect(root.querySelector('button')?.getAttribute('aria-label')).toBe('Stop');
    expect(root.textContent).toBe('');
    await act(() => update({ status: 'playing', slow: false, remote: true }));
    expect(root.textContent).toBe('');
    await click();
    expect(stop).toHaveBeenCalledOnce();
    expect(root.querySelector('button')?.getAttribute('aria-label')).toBe('Listen to translation');
  });

  it('ignores synthetic clicks', async () => {
    await mount();
    vi.mocked(trust.isTrustedEvent).mockReturnValue(false);
    await click();
    expect(speak).not.toHaveBeenCalled();
  });

  it('stops on leaving the result and ignores late reports', async () => {
    await mount();
    await click();
    await act(() => update({ status: 'starting' }));
    await act(() => render(null, root));
    expect(stop).toHaveBeenCalledOnce();
    await act(() => update({ status: 'playing', slow: false, remote: false }));
    expect(root.childElementCount).toBe(0);
  });

  it('shows speech failures and returns to an actionable speaker button', async () => {
    await mount();
    await click();
    await act(() => update({ status: 'unavailable', message: 'speechNoVoiceForLanguage' }));
    expect(root.textContent).toMatch(/voice.*language/i);
    expect(root.querySelector('button')?.getAttribute('aria-pressed')).toBe('false');
  });
});
