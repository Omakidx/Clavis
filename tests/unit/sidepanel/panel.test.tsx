// @vitest-environment jsdom
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sidePanelHandoffSchema } from '../../../lib/contracts';
import { flush } from '../explanation/support';
import { installCatalog, makeDeps, makeHandoff, mountPanel, stateOf } from './support';

beforeEach(() => {
  installCatalog();
  // jsdom has no layout: scrolling is a no-op, matchMedia is absent.
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn(() => ({ matches: false })) as never;
});
afterEach(cleanup);

const sections = () => screen.queryAllByTestId('panel-section');
const section = (mode: string) =>
  sections().find((el) => el.getAttribute('data-mode') === mode) as HTMLElement;

describe('opening the panel', () => {
  it('shows a loading line, then the explanation of the hand-off for its tab', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'word', text: 'bank' })));
    await mountPanel(setup);
    expect(setup.fetchState).toHaveBeenCalledWith(7);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Clavis explanation');
    expect(screen.getByTestId('panel-selected')).toHaveTextContent('bank');
    expect(screen.getByText('Word')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-loading-state')).toBeNull();
  });

  it('sends NOTHING when it opens (no Groq request, not even for a missing core answer)', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ modes: ['etymology'] })));
    await mountPanel(setup);
    await flush();
    expect(setup.fake.calls).toHaveLength(0);
    // The core section offers to load; it does not load by itself.
    expect(within(section('core')).getByTestId('panel-load')).toHaveTextContent('Load Core');
  });

  it('lays every part of the selection out as a section with its own heading, in tab order', async () => {
    const setup = makeDeps(
      stateOf(makeHandoff({ kind: 'word', modes: ['core', 'related_words'], active: 'core' })),
    );
    await mountPanel(setup);
    expect(sections().map((el) => el.getAttribute('data-mode'))).toEqual([
      'core',
      'etymology',
      'related_words',
    ]);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(['Core', 'Roots', 'Related words']));
    for (const el of sections()) {
      expect(el.getAttribute('aria-labelledby')).toMatch(/^sp-heading-/);
      expect(document.getElementById(el.getAttribute('aria-labelledby') ?? '')).not.toBeNull();
    }
    expect(section('core').getAttribute('data-status')).toBe('ready');
    expect(section('etymology').getAttribute('data-status')).toBe('idle');
    expect(within(section('core')).getByText('bank (noun)')).toBeInTheDocument();
  });

  it('only offers the sections the card would (a sentence has no Roots)', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'sentence', text: 'She broke the ice.' })));
    await mountPanel(setup);
    expect(sections().map((el) => el.getAttribute('data-mode'))).toEqual(['core', 'simplify']);
  });

  it('has a labelled list of links to the sections that moves focus to the heading', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'word' })));
    await mountPanel(setup);
    const nav = screen.getByRole('navigation', { name: 'Parts of this explanation' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('data-mode'))).toEqual([
      'core',
      'etymology',
      'related_words',
    ]);
    // A part that is not loaded says so to a screen reader.
    expect(links[1]).toHaveTextContent('Roots (not loaded)');
    await userEvent.setup().click(links[2]!);
    expect(document.activeElement).toBe(document.getElementById('sp-heading-related_words'));
  });

  it('says how to fill it, and that Clavis forgets, when nothing is waiting (worker restarted)', async () => {
    const setup = makeDeps(undefined);
    await mountPanel(setup);
    const empty = screen.getByTestId('panel-empty');
    expect(empty).toHaveTextContent('No explanation to show');
    expect(empty).toHaveTextContent('Open in side panel');
    expect(empty).toHaveTextContent('select it again');
    expect(sections()).toHaveLength(0);
    expect(setup.fake.calls).toHaveLength(0);
  });

  it('is empty without asking anyone when it was not opened for a tab', async () => {
    const setup = makeDeps(stateOf(makeHandoff()), { tabId: undefined });
    await mountPanel(setup);
    expect(setup.fetchState).not.toHaveBeenCalled();
    expect(screen.getByTestId('panel-empty')).toBeInTheDocument();
  });
});

describe('model and page text is only ever text (D-10)', () => {
  it('renders markup, scripts, Markdown and links as literal characters', async () => {
    const hostile =
      '<img src=x onerror="alert(1)"><script>alert(2)</script> **bold** [x](javascript:alert(3))';
    const setup = makeDeps(
      stateOf(
        makeHandoff({
          kind: 'sentence',
          text: hostile,
          overrides: {
            core: {
              title: hostile,
              summary: hostile,
              definition: hostile,
              caveat: hostile,
              examples: [{ sentence: hostile }, { sentence: '<b>two</b>' }],
            },
          },
        }),
      ),
    );
    const { container } = await mountPanel(setup);
    expect(screen.getByTestId('panel-selected').textContent).toBe(hostile);
    expect(section('core').textContent).toContain(hostile);
    expect(container.querySelector('img, script, b, strong')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    // The only links are our own in-page section links.
    for (const link of Array.from(container.querySelectorAll('a'))) {
      expect(link.getAttribute('href')).toMatch(/^#sp-section-/);
    }
  });

  it('lets selected text and every piece of model text choose its own direction', async () => {
    const setup = makeDeps(
      stateOf(
        makeHandoff({
          kind: 'phrase',
          text: 'مرحبا بالعالم',
          overrides: {
            core: {
              title: 'مرحبا',
              summary: 'تحية عربية',
              examples: [{ sentence: 'مرحبا يا صديقي' }, { sentence: 'Say مرحبا to her' }],
            },
          },
        }),
      ),
    );
    await mountPanel(setup);
    expect(screen.getByTestId('panel-selected')).toHaveAttribute('dir', 'auto');
    const result = within(section('core')).getByTestId('panel-result');
    const texts = Array.from(result.querySelectorAll('p:not(.sp-label), li'));
    expect(texts.length).toBeGreaterThan(4);
    for (const el of texts) expect(el.getAttribute('dir'), el.textContent ?? '').toBe('auto');
    for (const label of Array.from(result.querySelectorAll('.sp-label'))) {
      expect(label.getAttribute('dir')).toBeNull();
    }
  });
});

describe('loading the remaining modes on demand (D-05)', () => {
  it('Load sends exactly one request for that part, shows it loading, then the result', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'word', modes: ['core'] })));
    await mountPanel(setup);
    await userEvent.setup().click(within(section('etymology')).getByTestId('panel-load'));
    expect(setup.fake.calls).toHaveLength(1);
    expect(setup.fake.calls[0]?.request).toMatchObject({ mode: 'etymology' });
    expect(setup.fake.calls[0]?.request.snapshot.contextBefore).toBe('They sat on the ');
    expect(setup.fake.calls[0]?.acknowledge).toBe(false);
    expect(within(section('etymology')).getByTestId('panel-loading')).toHaveTextContent(
      'Loading Roots…',
    );
    await act(async () => {
      setup.fake.calls[0]?.succeed();
      await flush();
    });
    expect(section('etymology').getAttribute('data-status')).toBe('ready');
    expect(within(section('etymology')).queryByTestId('panel-load')).toBeNull();
    // Nothing else was requested, and reading it again costs nothing.
    expect(setup.fake.calls).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Roots' })).toBeInTheDocument();
  });

  it('retries only when asked, and counts a rate limit down before it allows it', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'word' })));
    await mountPanel(setup);
    const user = userEvent.setup();
    await user.click(within(section('etymology')).getByTestId('panel-load'));
    await act(async () => {
      setup.fake.calls[0]?.reply({ kind: 'error', code: 'RATE_LIMITED', retryAfterMs: 5000 });
      await flush();
    });
    const retry = within(section('etymology')).getByTestId('panel-retry');
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).toHaveTextContent('Try again in 5 s');
    expect(within(section('etymology')).getByTestId('panel-error')).toHaveTextContent(
      'Rate limit reached',
    );
    await user.click(retry);
    expect(setup.fake.calls).toHaveLength(1);
    setup.state.now += 5001;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    expect(retry).not.toHaveAttribute('aria-disabled');
    await user.click(retry);
    expect(setup.fake.calls).toHaveLength(2);
  }, 10_000);

  it.each([
    ['SETUP_REQUIRED', 'Connect Groq', 'key'],
    ['INVALID_API_KEY', 'Update key', 'key'],
    ['MODEL_UNAVAILABLE', 'Choose another model', 'model'],
  ] as const)(
    '%s offers a button that opens Settings at the right section',
    async (code, label, target) => {
      const setup = makeDeps(stateOf(makeHandoff({ kind: 'word' })));
      await mountPanel(setup);
      const user = userEvent.setup();
      await user.click(within(section('related_words')).getByTestId('panel-load'));
      await act(async () => {
        setup.fake.calls[0]?.reply({ kind: 'error', code });
        await flush();
      });
      await user.click(within(section('related_words')).getByRole('button', { name: label }));
      expect(setup.fake.settings).toEqual([target]);
    },
  );

  it('words a connection failure as offline when the browser says so', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'word' })));
    setup.state.online = false;
    await mountPanel(setup);
    await userEvent.setup().click(within(section('etymology')).getByTestId('panel-load'));
    await act(async () => {
      setup.fake.calls[0]?.reply({ kind: 'error', code: 'NETWORK_ERROR' });
      await flush();
    });
    const error = within(section('etymology')).getByTestId('panel-error');
    expect(error).toHaveAttribute('data-offline', 'true');
    expect(error).toHaveTextContent("You're offline");
  });

  it('never acknowledges the disclosure itself: the card is the only place for that', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'word' })));
    await mountPanel(setup);
    const user = userEvent.setup();
    await user.click(within(section('etymology')).getByTestId('panel-load'));
    await act(async () => {
      setup.fake.calls[0]?.reply({ kind: 'disclosure' });
      await flush();
    });
    expect(within(section('etymology')).getByTestId('panel-disclosure')).toHaveTextContent(
      'Confirm it in the explanation card',
    );
    expect(screen.queryByText('Explain', { selector: 'button' })).toBeNull();
    // "Try again" asks again without the acknowledgement.
    await user.click(within(section('etymology')).getByRole('button', { name: 'Try again' }));
    expect(setup.fake.calls).toHaveLength(2);
    expect(setup.fake.calls.map((c) => c.acknowledge)).toEqual([false, false]);
  });

  it('a request still pending when the selection is replaced is cancelled and never shown', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'word', text: 'bank' }), 1));
    await mountPanel(setup);
    await userEvent.setup().click(within(section('etymology')).getByTestId('panel-load'));
    const first = setup.fake.calls[0]!;
    await setup.push(stateOf(makeHandoff({ kind: 'word', text: 'river' }), 2));
    expect(setup.fake.cancelled).toContain(first.request.requestId);
    await act(async () => {
      first.succeed();
      await flush();
    });
    expect(screen.getByTestId('panel-selected')).toHaveTextContent('river');
    expect(section('etymology').getAttribute('data-status')).toBe('idle');
  });
});

describe('a newer hand-off while the panel is open', () => {
  it('replaces the explanation for another selection and announces it without moving focus', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ text: 'bank' }), 1));
    await mountPanel(setup);
    const link = screen.getAllByRole('link')[0]!;
    link.focus();
    await setup.push(stateOf(makeHandoff({ text: 'river' }), 2));
    expect(screen.getByTestId('panel-selected')).toHaveTextContent('river');
    expect(document.activeElement).toBe(link);
    expect(
      screen
        .getAllByRole('status')
        .map((el) => el.textContent)
        .join(' '),
    ).toContain('Now showing the explanation of river.');
  });

  it('merges more loaded parts for the SAME selection and keeps what the panel loaded itself', async () => {
    const first = makeHandoff({ kind: 'word', text: 'bank', modes: ['core'] });
    const setup = makeDeps(stateOf(first, 1));
    await mountPanel(setup);
    const user = userEvent.setup();
    await user.click(within(section('related_words')).getByTestId('panel-load'));
    await act(async () => {
      setup.fake.calls[0]?.succeed();
      await flush();
    });
    const second = {
      ...first,
      results: [
        ...first.results,
        makeHandoff({ kind: 'word', text: 'bank', modes: ['etymology'] }).results[0]!,
      ],
      active: 'etymology' as const,
    };
    await setup.push(stateOf(second, 2));
    expect(section('etymology').getAttribute('data-status')).toBe('ready');
    expect(section('related_words').getAttribute('data-status')).toBe('ready');
    expect(setup.fake.calls).toHaveLength(1);
  });

  it('goes back to the empty state when the worker drops the hand-off (page left, data cleared)', async () => {
    const setup = makeDeps(stateOf(makeHandoff()));
    await mountPanel(setup);
    await setup.push({ revision: 3, handoff: null });
    expect(screen.getByTestId('panel-empty')).toBeInTheDocument();
    expect(sections()).toHaveLength(0);
  });
});

describe('copy', () => {
  it('copies one section, or everything loaded, as plain text', async () => {
    const setup = makeDeps(
      stateOf(makeHandoff({ kind: 'word', text: 'bank', modes: ['core', 'related_words'] })),
    );
    await mountPanel(setup);
    const user = userEvent.setup();
    await user.click(within(section('core')).getByRole('button', { name: 'Copy Core' }));
    expect(setup.copied[0]).toMatch(/^Core\nbank \(noun\)/);
    expect(setup.copied[0]).not.toMatch(/[<>]/);
    await user.click(screen.getByTestId('panel-copy-all'));
    const all = setup.copied[1] ?? '';
    expect(all.startsWith('bank\n\nCore\n')).toBe(true);
    expect(all).toContain('Related words\n');
    expect(all).not.toContain('Roots');
    expect(
      screen
        .getAllByRole('status')
        .map((el) => el.textContent)
        .join(' '),
    ).toContain('Copied');
  });

  it('says so when copying is not available', async () => {
    const setup = makeDeps(stateOf(makeHandoff()));
    setup.state.copyOk = false;
    await mountPanel(setup);
    await userEvent.setup().click(screen.getByTestId('panel-copy-all'));
    expect(
      screen
        .getAllByRole('status')
        .map((el) => el.textContent)
        .join(' '),
    ).toContain("Copy isn't available");
  });

  it('has no Copy button on a part that is not loaded', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'word' })));
    await mountPanel(setup);
    expect(within(section('etymology')).queryByTestId('panel-copy-section')).toBeNull();
  });
});

describe('Listen for the selected text', () => {
  it('speaks only the selected text (never its context) and shows Stop while it plays', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ kind: 'word', text: 'bank' })));
    await mountPanel(setup);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('panel-listen'));
    expect(setup.speech.listen).toHaveBeenCalledTimes(1);
    const run = setup.runs[0]!;
    expect(run.snapshot.text).toBe('bank');
    expect(run.listen?.slow).toBeUndefined();
    await act(async () => run.listen?.report({ status: 'starting' }));
    expect(screen.getByTestId('panel-stop')).toBeInTheDocument();
    await act(async () => run.listen?.report({ status: 'playing', slow: false, remote: false }));
    expect(screen.getByTestId('panel-listen-status')).toHaveTextContent('Playing.');
    await user.click(screen.getByTestId('panel-stop'));
    expect(run.signal.aborted).toBe(true);
    expect(screen.getByTestId('panel-listen')).toBeInTheDocument();
  });

  it('plays slow when Slow is on, offers Replay when it finished and says when there is no voice', async () => {
    const setup = makeDeps(stateOf(makeHandoff()));
    await mountPanel(setup);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('panel-slow'));
    expect(screen.getByTestId('panel-slow')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('panel-listen'));
    const run = setup.runs[0]!;
    expect(run.listen?.slow).toBe(true);
    await act(async () => run.listen?.report({ status: 'ended' }));
    expect(screen.getByTestId('panel-listen')).toHaveTextContent('Replay');
    await user.click(screen.getByTestId('panel-listen'));
    await act(async () =>
      setup.runs[1]?.listen?.report({
        status: 'unavailable',
        message: 'speechNoVoice',
        hint: 'speechNoVoiceLinuxHint',
      }),
    );
    expect(screen.getByTestId('panel-listen-status')).toHaveTextContent(
      "Voice isn't available on this device.",
    );
    await user.click(screen.getByRole('button', { name: 'Voice settings' }));
    expect(setup.speech.openVoiceSettings).toHaveBeenCalledTimes(1);
  });

  it('stops what plays when another selection replaces this one', async () => {
    const setup = makeDeps(stateOf(makeHandoff({ text: 'bank' }), 1));
    await mountPanel(setup);
    await userEvent.setup().click(screen.getByTestId('panel-listen'));
    const run = setup.runs[0]!;
    await setup.push(stateOf(makeHandoff({ text: 'river' }), 2));
    expect(run.signal.aborted).toBe(true);
    expect(screen.getByTestId('panel-listen')).toBeInTheDocument();
  });
});

describe('the hand-off the card sends is a valid one', () => {
  it('makeHandoff matches the contract (guards the fixtures themselves)', () => {
    expect(
      sidePanelHandoffSchema.safeParse(
        makeHandoff({ kind: 'phrase', modes: ['core', 'etymology', 'related_words'] }),
      ).success,
    ).toBe(true);
  });
});
