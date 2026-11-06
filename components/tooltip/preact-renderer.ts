import { h, render, type VNode } from 'preact';
import type { ViewRenderer } from './toolbar';
import { toolbarView, type CreateElement } from './view';

/** Preact renderer shared by the on-demand website toolbar and extension-owned readers. */
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
