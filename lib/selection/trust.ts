/**
 * Page scripts can dispatch synthetic events (`element.click()`, `new KeyboardEvent`)
 * and drive programmatic selections. Only events the browser itself created from real
 * user input have `isTrusted === true`, so every Clavis action and every toolbar
 * trigger is gated on it (security review HIGH-1).
 *
 * Kept in one function so unit tests (jsdom never produces trusted events) can stub it.
 * React synthetic events wrap the native one: accept either.
 */
export function isTrustedEvent(event: Event): boolean {
  if (event.isTrusted === true) return true;
  const native = (event as unknown as { nativeEvent?: { isTrusted?: boolean } }).nativeEvent;
  return native?.isTrusted === true;
}
