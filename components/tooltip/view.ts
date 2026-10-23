import type { SelectionKind } from '../../lib/contracts/selection';
import { LIMITS } from '../../lib/config/constants';
import { t } from '../../lib/i18n';
import type { ToolbarActionName } from '../../lib/selection/ui-api';

/** What the toolbar shows. */
export type ToolbarMode =
  /** Listen and Explain for a selection within the limit. */
  | 'actions'
  /** "Selection too long" with the single trim action. */
  | 'too-long'
  /** A message that is not about a selection, with a close button. */
  | 'notice';

/** Buttons the user can press, in focus order. */
export type ButtonName = Exclude<ToolbarActionName, 'dismiss'> | 'close';

export interface ToolbarViewProps {
  mode: ToolbarMode;
  kind: SelectionKind;
  /** The notice text (mode `notice`). */
  notice: string;
  /**
   * Set after Listen or Explain: the card with the captured text. `note` is the state line.
   * `slot` replaces both with an empty container the separately loaded explanation card draws in
   * (CardSurface in lib/selection/ui-api.ts); the toolbar never renders model text itself.
   */
  card: { action: 'listen' | 'explain'; text: string; note: string; slot?: boolean } | null;
  /** Set after the trim action: the exact text that would be used, and its length. */
  trimmed: { text: string; length: number } | null;
  /** The button that is working (aria-disabled, highlighted) until its action settles. */
  busy: 'listen' | 'explain' | null;
  /** Text for the polite live region; empty when there is nothing to announce. */
  live: string;
  /** `event` is the click that triggered it; the shell ignores untrusted (page-made) ones. */
  onAction(action: ButtonName, event: Event): void;
}

/**
 * Element factory with the signature shared by `React.createElement` and Preact's `h`, so the
 * view is written once and stays independent of the UI library.
 */
export type CreateElement<N> = (
  type: string,
  props: Record<string, unknown> | null,
  ...children: Array<N | string | null>
) => N;

const COUNT = LIMITS.maxSelectionChars.toLocaleString();

export function toolbarView<N>(props: ToolbarViewProps, h: CreateElement<N>): N {
  const { mode, card, trimmed } = props;

  const button = (name: ButtonName, label: string): N =>
    h(
      'button',
      {
        type: 'button',
        className: 'button',
        'data-action': name,
        'aria-disabled': props.busy === name ? 'true' : null,
        'data-state': props.busy === name ? 'working' : null,
        onClick: (event: Event) => props.onAction(name, event),
      },
      label,
    );

  const toolbar = (...buttons: N[]): N =>
    h(
      'div',
      {
        className: 'toolbar',
        role: 'toolbar',
        'aria-label': t('toolbarGroupLabel'),
        'data-clavis': 'toolbar',
      },
      ...buttons,
    );

  const head =
    mode === 'too-long'
      ? h(
          'div',
          { className: 'card', 'data-clavis': 'limit' },
          h('p', { className: 'card__title' }, t('toolbarTooLong')),
          h('p', { className: 'card__note' }, t('toolbarTooLongHint', COUNT)),
        )
      : mode === 'notice'
        ? h(
            'div',
            { className: 'card', 'data-clavis': 'notice' },
            h('p', null, props.notice),
            button('close', t('toolbarClose')),
          )
        : null;

  return h(
    'div',
    {
      className: 'panel',
      'data-clavis': 'panel',
      'data-kind': props.kind,
      'data-mode': mode,
      'data-card': card?.slot === true ? 'explain' : null,
    },
    head,
    mode === 'actions'
      ? toolbar(button('listen', t('toolbarListen')), button('explain', t('toolbarExplain')))
      : mode === 'too-long'
        ? toolbar(button('trim', t('toolbarUseFirst', COUNT)))
        : null,
    trimmed === null
      ? null
      : h(
          'div',
          { className: 'card', 'data-clavis': 'trimmed' },
          h('p', { className: 'card__note' }, t('toolbarTrimmed', trimmed.length.toLocaleString())),
          h(
            'p',
            {
              className: 'card__text card__text--scroll',
              tabIndex: 0,
              role: 'group',
              'aria-label': t('toolbarTrimmedPreview'),
              'data-clavis': 'trimmed-text',
            },
            trimmed.text,
          ),
        ),
    card === null
      ? null
      : card.slot === true
        ? // A different tag than the state-line card, so switching between them never reuses a node
          // that holds the loaded card's own tree.
          h('section', { className: 'card-slot', 'data-clavis': 'card-slot' })
        : h(
            'div',
            { className: 'card', 'data-clavis': 'card', 'data-action': card.action },
            h('p', { className: 'card__note', 'data-clavis': 'card-note' }, card.note),
            h('p', { className: 'card__text', 'data-clavis': 'card-text' }, card.text),
          ),
    h('div', { className: 'sr-only', role: 'status', 'data-clavis': 'live' }, props.live),
  );
}
