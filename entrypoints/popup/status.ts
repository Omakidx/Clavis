import type { AiStatus } from '../../lib/contracts/setup';
import type { MessageKey } from '../../lib/i18n';

export interface GroqStatusView {
  text: MessageKey;
  tone: 'success' | 'warning' | 'danger';
  /** The one button that fixes it, if any. */
  action: 'connect' | 'update-key' | 'review' | 'none';
}

/** How each GET_AI_STATUS state looks in the popup. */
export const GROQ_STATUS: Record<AiStatus['state'], GroqStatusView> = {
  ready: { text: 'popupGroqReady', tone: 'success', action: 'none' },
  setup_required: { text: 'popupGroqSetup', tone: 'warning', action: 'connect' },
  invalid_key: { text: 'popupGroqInvalid', tone: 'danger', action: 'update-key' },
  disclosure_required: { text: 'popupGroqDisclosure', tone: 'warning', action: 'review' },
  storage_unavailable: { text: 'popupGroqStorage', tone: 'danger', action: 'none' },
};
