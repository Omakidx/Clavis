import type { ToolbarLoader } from '../../lib/selection/ui-api';
import { createPreactRenderer } from './preact-renderer';
import { createToolbar } from './toolbar';

/** Option (c): the Preact toolbar is part of the observer bundle, so nothing is loaded. */
export const bundledPreactLoader: ToolbarLoader = (options) =>
  Promise.resolve(createToolbar(createPreactRenderer(), options));
