// @vitest-environment jsdom
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from '../explanation/support';
import { installCatalog, makeDeps, makeHandoff, mountPanel, stateOf } from './support';

// The shipped flags are off; this file runs the panel as it will behave when they are flipped.
vi.mock('../../../lib/config/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/config/constants')>()),
  FEATURES: { grammarTab: true, translateTab: true },
}));

beforeEach(() => {
  installCatalog();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn(() => ({ matches: false })) as never;
});
afterEach(cleanup);

describe('side panel with Grammar and Translate switched on', () => {
  it('offers both sections and loads Translate with the language of the hand-off', async () => {
    const setup = makeDeps(
      stateOf({ ...makeHandoff({ kind: 'sentence', text: 'She broke the ice.' }) }),
    );
    await mountPanel(setup);
    const modes = screen.getAllByTestId('panel-section').map((el) => el.getAttribute('data-mode'));
    expect(modes).toEqual(['core', 'simplify', 'grammar', 'translate']);
    const translate = screen
      .getAllByTestId('panel-section')
      .find((el) => el.getAttribute('data-mode') === 'translate')!;
    await userEvent.setup().click(within(translate).getByTestId('panel-load'));
    // The language comes from the user's setting (the card had not loaded a translation yet).
    expect(setup.fake.calls[0]?.request).toMatchObject({ mode: 'translate', targetLanguage: 'en' });
    await act(async () => {
      setup.fake.calls[0]?.succeed({
        translation: { language: 'English', text: 'Elle a brisé la glace.' },
      });
      await flush();
    });
    expect(translate).toHaveTextContent('Translation into English');
  });
});
