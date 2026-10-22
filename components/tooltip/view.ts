import type { SelectionKind } from '../../lib/contracts/selection';
import { t } from '../../lib/i18n';

export type ToolbarActionName = 'listen' | 'explain';

export interface ToolbarViewProps {
  kind: SelectionKind;
  overLimit: boolean;
  /** Spike placeholder for the explanation card; set after a button click. */
  card: { action: ToolbarActionName; text: string } | null;
  /** `event` is the click that triggered it; the shell ignores untrusted (page-made) ones. */
  onAction(action: ToolbarActionName, event: Event): void;
}

/**
 * Element factory with the signature shared by `React.createElement` and
 * Preact's `h`. Both options (React chunk, Preact bundled) render the SAME
 * tree, so measurements compare loading strategies, not different UIs.
 */
export type CreateElement<N> = (
  type: string,
  props: Record<string, unknown> | null,
  ...children: Array<N | string | null>
) => N;

export function toolbarView<N>(props: ToolbarViewProps, h: CreateElement<N>): N {
  const { card } = props;
  return h(
    'div',
    { className: 'panel', 'data-clavis': 'panel', 'data-kind': props.kind },
    h(
      'div',
      {
        className: 'toolbar',
        role: 'toolbar',
        'aria-label': t('toolbarGroupLabel'),
        'data-clavis': 'toolbar',
      },
      h(
        'button',
        {
          type: 'button',
          className: 'button',
          'data-action': 'listen',
          onClick: (event: Event) => props.onAction('listen', event),
        },
        t('toolbarListen'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'button',
          'data-action': 'explain',
          onClick: (event: Event) => props.onAction('explain', event),
        },
        t('toolbarExplain'),
      ),
    ),
    card === null
      ? null
      : h(
          'div',
          {
            className: 'card',
            role: 'status',
            'data-clavis': 'card',
            'data-action': card.action,
          },
          h('p', { className: 'card__note' }, t('toolbarCardPlaceholder')),
          h('p', { className: 'card__text', 'data-clavis': 'card-text' }, card.text),
          props.overLimit ? h('p', { className: 'card__note' }, t('toolbarOverLimit')) : null,
        ),
  );
}
