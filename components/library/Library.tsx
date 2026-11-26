import { useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../../lib/i18n';
import { Page } from '../common/Page';
import { Documents } from './Documents';
import { SavedWords } from './SavedWords';
import './library.css';

type Tab = 'words' | 'documents';
const TABS: readonly Tab[] = ['words', 'documents'];

/** `/library.html#documents` opens the documents tab (the popup's Library button). */
export function tabFromHash(hash: string): Tab {
  return hash.replace(/^#/, '') === 'documents' ? 'documents' : 'words';
}

/**
 * The library (docs/clavis-sync-design.md 7.7): saved words with their meaning, source and chat,
 * and the documents read in the reader. Reads IndexedDB directly; writes that need the Groq key go
 * through the background. Works signed out, with everything on this device.
 */
export function Library() {
  const [tab, setTab] = useState<Tab>(() => tabFromHash(window.location.hash));
  const buttons = useRef(new Map<Tab, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent): void => {
    const index = TABS.indexOf(tab);
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[next];
    if (target === undefined) return;
    setTab(target);
    buttons.current.get(target)?.focus();
  };

  const label = (id: Tab): string => t(id === 'words' ? 'libraryTabWords' : 'libraryTabDocuments');

  return (
    <Page title={t('libraryTitle')}>
      <p className="clavis-muted">{t('libraryLocalNote')}</p>
      <div
        className="library-tabs"
        role="tablist"
        aria-label={t('libraryTabsLabel')}
        onKeyDown={onKeyDown}
      >
        {TABS.map((id) => (
          <button
            key={id}
            ref={(element) => {
              if (element) buttons.current.set(id, element);
              else buttons.current.delete(id);
            }}
            type="button"
            role="tab"
            id={`library-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`library-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className="library-tab"
            data-testid={`library-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {label(id)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`library-panel-${tab}`}
        aria-labelledby={`library-tab-${tab}`}
        className="library-panel"
      >
        {tab === 'words' ? <SavedWords /> : <Documents />}
      </div>
    </Page>
  );
}
