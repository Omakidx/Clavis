import { useEffect, useState } from 'react';
import { t } from '../../lib/i18n';
import type { WordsBackend } from '../explanation/backend';
import type { ExplainSession } from '../explanation/session';
import { Button } from '../common/ui';

interface Props {
  session: ExplainSession;
  words: WordsBackend;
  /** Tells the user what happened (the panel's polite live region). */
  announce(message: string): void;
}

/**
 * The same Save toggle as the card (docs/clavis-sync-design.md 7.5): shown for a word or phrase
 * once its core answer is loaded. The panel sends no source: the background reads the address and
 * title of the panel's own tab.
 */
const SAVE_FAILURE = {
  limit: 'cardSaveLimit',
  elsewhere: 'cardSaveElsewhere',
  failed: 'cardSaveFailed',
} as const;

export function SaveWord({ session, words, announce }: Props) {
  const savable = session.savable();
  const text = savable?.snapshot.text;
  const [saved, setSaved] = useState<{ wordKey: string; saved: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (text === undefined) return;
    let current = true;
    void words.lookup(text).then((found) => {
      if (current) setSaved(found);
    });
    return () => {
      current = false;
    };
  }, [words, text]);

  if (savable === null) return null;

  const toggle = (): void => {
    if (busy) return;
    setBusy(true);
    const finish = (next: typeof saved, message: string): void => {
      setBusy(false);
      if (next !== null) setSaved(next);
      announce(message);
    };
    if (saved?.saved === true) {
      void words.remove(saved.wordKey).then((ok) => {
        finish(
          ok ? { wordKey: saved.wordKey, saved: false } : null,
          t(ok ? 'cardUnsaveAnnounce' : 'cardSaveFailed'),
        );
      });
      return;
    }
    void words.save(savable.snapshot, savable.meaning).then((outcome) => {
      if (outcome.ok) finish({ wordKey: outcome.wordKey, saved: true }, t('cardSaveAnnounce'));
      else finish(null, t(SAVE_FAILURE[outcome.reason]));
    });
  };

  return (
    <Button data-testid="panel-save" aria-disabled={busy ? 'true' : undefined} onClick={toggle}>
      {saved?.saved === true ? t('cardSaved') : t('cardSave')}
    </Button>
  );
}
