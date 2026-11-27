// @vitest-environment jsdom
import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from '../explanation/support';
import { installCatalog, makeDeps, makeHandoff, mountPanel, stateOf } from './support';

beforeEach(() => {
  installCatalog();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn(() => ({ matches: false })) as never;
});
afterEach(cleanup);

describe('the Save toggle in the side panel', () => {
  it('saves a word from the core section, with no source or pdf part of its own', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'word', text: 'bank' })));
    await mountPanel(setup);
    const user = userEvent.setup();
    const button = await screen.findByTestId('panel-save');
    expect(button).toHaveTextContent('Save word');
    await user.click(button);
    await act(() => flush());
    expect(setup.fake.saves).toHaveLength(1);
    expect(setup.fake.saves[0]!.snapshot).toMatchObject({ text: 'bank', kind: 'word' });
    expect(setup.fake.saves[0]!.meaning).toMatchObject({
      title: expect.any(String),
      model: expect.any(String),
    });
    expect(setup.fake.saves[0]!.pdf).toBeUndefined();
    expect(screen.getByTestId('panel-save')).toHaveTextContent('Saved');
    expect(screen.getByText('Saved to your library.')).toBeInTheDocument();
    await user.click(screen.getByTestId('panel-save'));
    await act(() => flush());
    expect(setup.fake.removed).toHaveLength(1);
    expect(screen.getByTestId('panel-save')).toHaveTextContent('Save word');
  });

  it('is absent for a sentence and until the core answer is loaded', async () => {
    await mountPanel(
      makeDeps(stateOf(makeHandoff({ kind: 'sentence', text: 'A whole sentence.' }))),
    );
    expect(screen.queryByTestId('panel-save')).toBeNull();
    cleanup();
    await mountPanel(
      makeDeps(stateOf(makeHandoff({ kind: 'word', text: 'bank', modes: ['etymology'] }))),
    );
    expect(screen.queryByTestId('panel-save')).toBeNull();
  });
});
