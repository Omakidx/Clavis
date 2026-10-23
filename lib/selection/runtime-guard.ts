/** How often an injected script checks that its extension is still there. */
const CHECK_MS = 10_000;

/** Whether the extension this script belongs to still exists (false after an update or removal). */
export function runtimeAlive(): boolean {
  return (browser.runtime as { id?: string } | undefined)?.id !== undefined;
}

/**
 * Runs `onGone` once when the extension runtime is gone. Content scripts are unlisted scripts
 * (no WXT ContentScriptContext): that context announces every start with a document event that
 * carries the extension id, which a page can listen for. A page can neither see nor fake this check.
 * Returns the function that stops watching.
 */
export function onRuntimeGone(onGone: () => void): () => void {
  const timer = setInterval(() => {
    if (runtimeAlive()) return;
    clearInterval(timer);
    onGone();
  }, CHECK_MS);
  return () => clearInterval(timer);
}
