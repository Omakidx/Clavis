import type { ToolbarLoader } from '../../lib/selection/ui-api';
import { createPreactRenderer } from './preact-renderer';
import { createToolbar } from './toolbar';

/** Constructs Preact UI after toolbar.js has been injected into the document. */
export const bundledPreactLoader: ToolbarLoader = (options) =>
  Promise.resolve(createToolbar(createPreactRenderer(), options));
