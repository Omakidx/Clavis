/**
 * Identifies Clavis's own toolbar host WITHOUT a distinguishing tag name or attribute
 * that page scripts could target (a custom-element tag would even let a page read a
 * closed shadow root through ElementInternals). Hosts are registered in a WeakSet held
 * on a symbol-keyed global of the extension's isolated world, which the page's main
 * world cannot see, and which is shared between the observer and the lazily loaded UI.
 */
const OWN_UI_HOSTS = Symbol.for('clavis.own-ui-hosts');

function registry(): WeakSet<Node> {
  const world = globalThis as Record<symbol, WeakSet<Node> | undefined>;
  return (world[OWN_UI_HOSTS] ??= new WeakSet<Node>());
}

export function markOwnUi(host: Node): void {
  registry().add(host);
}

/** True for a Clavis host or anything inside it (selections inside a shadow root retarget to the host). */
export function isOwnUiNode(node: Node | null): boolean {
  const hosts = registry();
  for (let current: Node | null = node; current !== null; current = current.parentNode ?? null) {
    if (hosts.has(current)) return true;
  }
  return false;
}
