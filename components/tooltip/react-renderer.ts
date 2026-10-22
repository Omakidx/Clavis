import { createElement, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ViewRenderer } from './toolbar';
import { toolbarView, type CreateElement } from './view';

/** React 19 renderer, used by the lazily loaded UI script (options a and b, and the card in c). */
export function createReactRenderer(): ViewRenderer {
  let root: Root | null = null;
  const h = createElement as unknown as CreateElement<ReactElement>;
  return {
    render(container, props) {
      const current = (root ??= createRoot(container));
      // Synchronous: the toolbar must be measured and placed in the same task.
      flushSync(() => current.render(toolbarView(props, h)));
    },
    unmount() {
      root?.unmount();
      root = null;
    },
  };
}
