import type { AiStatus } from '../../lib/contracts/setup';
import type { MessageKey } from '../../lib/i18n';

export interface GroqStatusView {
  text: MessageKey;
  tone: 'success' | 'warning' | 'danger';
  /** The one button that fixes it, if any. */
  action: 'connect' | 'update-key' | 'review' | 'none';
  /** What to tell the person, in order (empty when Groq is ready). */
  notice: readonly MessageKey[];
}

/** How each GET_AI_STATUS state looks in the popup. */
export const GROQ_STATUS: Record<AiStatus['state'], GroqStatusView> = {
  ready: { text: 'popupGroqReady', tone: 'success', action: 'none', notice: [] },
  setup_required: {
    text: 'popupGroqSetup',
    tone: 'warning',
    action: 'connect',
    notice: ['errSetupRequired', 'keyNoneHint'],
  },
  invalid_key: {
    text: 'popupGroqInvalid',
    tone: 'danger',
    action: 'update-key',
    notice: ['errInvalidApiKey'],
  },
  disclosure_required: {
    text: 'popupGroqDisclosure',
    tone: 'warning',
    action: 'review',
    notice: ['popupDisclosureBody'],
  },
  storage_unavailable: {
    text: 'popupGroqStorage',
    tone: 'danger',
    action: 'none',
    notice: ['errStorage'],
  },
};

/**
 * Whether a tab's address looks like a PDF: http(s) or file, with a path ending in `.pdf`. That is
 * all the popup can know without the `tabs` permission: it sees the address only because opening
 * the popup grants `activeTab`. A PDF served without that ending is not detected, and a page that
 * ends in `.pdf` but is not a PDF is a rare false positive whose only effect is a help notice.
 */
export function isPdfTabUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const { protocol, pathname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'file:') return false;
    return /\.pdf$/i.test(decodeURIComponent(pathname));
  } catch {
    return false;
  }
}
