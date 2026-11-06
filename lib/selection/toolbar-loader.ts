import { browser } from 'wxt/browser';
import { MESSAGE_VERSION } from '../config/constants';
import { TOOLBAR_GLOBAL, type ToolbarLoader, type ToolbarOptions } from './ui-api';

export interface ToolbarLoaderDeps {
  send(message: unknown): Promise<unknown>;
}

const defaultDeps: ToolbarLoaderDeps = {
  send: (message) => browser.runtime.sendMessage(message),
};

let loading: Promise<ToolbarLoader> | null = null;
const registered = (): ToolbarLoader | undefined =>
  (globalThis as Record<symbol, ToolbarLoader | undefined>)[TOOLBAR_GLOBAL];

async function inject(deps: ToolbarLoaderDeps): Promise<ToolbarLoader> {
  const reply = await deps.send({ v: MESSAGE_VERSION, type: 'LOAD_TOOLBAR' });
  const factory = registered();
  // executeScript finishes after the synchronous factory registration. Do not wait indefinitely
  // or expose extension scripts as web-accessible resources to load the UI.
  if ((reply as { ok?: unknown } | null | undefined)?.ok !== true || factory === undefined) {
    throw new Error('Clavis toolbar could not load');
  }
  return factory;
}

/** Shared injection per document; each controller still gets its own disposable toolbar handle. */
export async function loadToolbar(options: ToolbarOptions, deps: ToolbarLoaderDeps = defaultDeps) {
  let factory = registered();
  if (factory === undefined) {
    loading ??= inject(deps).finally(() => {
      loading = null;
    });
    factory = await loading;
  }
  return factory(options);
}
