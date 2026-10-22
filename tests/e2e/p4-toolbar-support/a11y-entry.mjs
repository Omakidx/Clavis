/* global CSSStyleSheet, document */
// TEST-ONLY bundle entry (never part of the extension). Renders the production toolbar view and
// stylesheet into an OPEN shadow root on an ordinary page, so axe can see inside it: on a real
// page the root is closed (security review HIGH-1) and axe cannot.
//
// Plain .mjs on purpose: tsconfig.node.json type-checks tests/e2e but cannot resolve the
// extension's `wxt/browser` types; esbuild (with an alias to ./browser-stub.ts) bundles this.
import { h, render } from 'preact';
import { toolbarView } from '../../../components/tooltip/view.ts';

/**
 * @param {ShadowRoot} root
 * @param {object} props ToolbarViewProps
 * @param {string} css text of components/tooltip/toolbar.css (the spec reads it from disk)
 * @returns {HTMLElement}
 */
export function mount(root, props, css) {
  if (root.adoptedStyleSheets.length === 0) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  }
  let container = root.querySelector('div.mount');
  if (container === null) {
    container = document.createElement('div');
    container.className = 'mount';
    root.append(container);
  }
  render(toolbarView(props, h), container);
  return container;
}
