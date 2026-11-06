import { bundledPreactLoader } from '../components/tooltip/bundled-loader';
import { onRuntimeGone, runtimeAlive } from '../lib/selection/runtime-guard';
import { TOOLBAR_GLOBAL, type ToolbarLoader } from '../lib/selection/ui-api';

// Packaged UI injected by the background only when a document first needs its toolbar. Like
// observer.js and explain-card.js, this runs in the isolated world and announces nothing to pages.
export default defineUnlistedScript({
  main() {
    if (!runtimeAlive()) return;
    const world = globalThis as Record<symbol, ToolbarLoader | undefined>;
    if (world[TOOLBAR_GLOBAL] !== undefined) return;
    world[TOOLBAR_GLOBAL] = bundledPreactLoader;
    onRuntimeGone(() => {
      if (world[TOOLBAR_GLOBAL] === bundledPreactLoader) delete world[TOOLBAR_GLOBAL];
    });
  },
});
