import { browser } from 'wxt/browser';
import type messages from '../../public/_locales/en/messages.json';

/** Every message key defined in public/_locales/en/messages.json. */
export type MessageKey = keyof typeof messages;

/**
 * Typed wrapper over `browser.i18n.getMessage` (D-11). Every user-visible string
 * must come through here. The key is checked against the English catalog at
 * compile time; if the browser still returns nothing (catalog drift, broken
 * locale build) a visible marker is returned in development so the gap cannot
 * ship unnoticed, and an empty string in production.
 */
export function t(key: MessageKey, substitutions?: string | string[]): string {
  const text = browser.i18n.getMessage(key, substitutions);
  if (text !== '') return text;
  return import.meta.env.DEV ? `⟦${key}⟧` : '';
}
