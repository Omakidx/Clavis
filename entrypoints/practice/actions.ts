import type { ListenReport } from '../../lib/selection/ui-api';
import { t } from '../../lib/i18n';

/**
 * What the practice page's result panel shows for Listen. Plain data: it is rendered as text
 * nodes. The toolbar shows the same states next to the selection; this panel mirrors them so the
 * demo explains itself. Explain does not report here: its answer opens in the explanation card.
 */
export type PracticeState =
  | { kind: 'idle' }
  | { kind: 'starting' | 'playing' | 'ended' | 'stopped'; text: string }
  /** Nothing is playing and the user needs to know why. */
  | {
      kind: 'problem';
      text: string;
      message: string;
      hint: string;
      /** Offer the "Voice settings" action (no voice on this device). */
      voiceSettings: boolean;
    };

/** Turn one Listen report into what the panel shows (`text` is the selection it is about). */
export function practiceStateFor(report: ListenReport, text: string): PracticeState {
  switch (report.status) {
    case 'starting':
    case 'playing':
      return { kind: report.status, text };
    case 'idle':
      return { kind: 'stopped', text };
    case 'ended':
      return report.message === undefined
        ? { kind: 'ended', text }
        : { kind: 'problem', text, message: t(report.message), hint: '', voiceSettings: false };
    case 'failed':
    case 'unavailable':
      return {
        kind: 'problem',
        text,
        message: t(report.message),
        hint: report.hint === undefined ? '' : t(report.hint),
        voiceSettings: report.status === 'unavailable',
      };
  }
}
