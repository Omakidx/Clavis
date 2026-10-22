import { h, render, type VNode } from 'preact';
import type { ViewRenderer } from './toolbar';
import { toolbarView, type CreateElement } from './view';

/** Preact renderer, bundled directly into the observer in option (c). */
export function createPreactRenderer(): ViewRenderer {
  const create = h as unknown as CreateElement<VNode>;
  return {
    render(container, props) {
      render(toolbarView(props, create), container);
    },
    unmount(container) {
      render(null, container);
    },
  };
}
