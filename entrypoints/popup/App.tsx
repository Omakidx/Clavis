import { useState } from 'react';
import { browser } from 'wxt/browser';
import { Page } from '../../components/common/Page';
import { t } from '../../lib/i18n';
import { injectTabMessage, type InjectResult } from '../../lib/site-access/messages';
import { useSiteAccess } from '../../lib/site-access/use-site-access';

function openReader() {
  void browser.tabs.create({ url: browser.runtime.getURL('/reader.html') });
  window.close();
}

function openSettings() {
  void browser.runtime.openOptionsPage();
  window.close();
}

type InjectState = 'idle' | 'busy' | 'no-selection' | 'restricted' | 'no-access' | 'failed';

/**
 * Toolbar-icon fallback (FR-018). The action has a popup, so `action.onClicked`
 * never fires; opening the popup is the user gesture that grants `activeTab`
 * for the current tab, and this button then asks the background to inject.
 */
async function explainOnThisPage(): Promise<InjectState> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return 'failed';
  const reply = (await browser.runtime.sendMessage(injectTabMessage(tab.id, tab.url))) as
    InjectResult | undefined;
  if (reply === undefined) return 'failed';
  if (reply.ok) return reply.shown ? 'idle' : 'no-selection';
  return reply.reason === 'restricted' || reply.reason === 'no-access' ? reply.reason : 'failed';
}

const INJECT_MESSAGE = {
  'no-selection': 'popupInjectNoSelection',
  restricted: 'popupInjectRestricted',
  'no-access': 'popupInjectNoAccess',
  failed: 'popupInjectFailed',
} as const;

export function App() {
  const { status } = useSiteAccess();
  const [inject, setInject] = useState<InjectState>('idle');

  function onExplainHere() {
    setInject('busy');
    explainOnThisPage().then(
      (next) => {
        setInject(next);
        if (next === 'idle') window.close();
      },
      () => setInject('failed'),
    );
  }

  return (
    <Page title={t('extName')} size="narrow">
      <div className="page__actions">
        {status === 'not-granted' ? (
          <>
            <button
              type="button"
              className="button button--primary"
              disabled={inject === 'busy'}
              onClick={onExplainHere}
            >
              {t('popupInjectButton')}
            </button>
            <p>{t('popupInjectHint')}</p>
            {inject === 'idle' || inject === 'busy' ? null : (
              <p role="status">{t(INJECT_MESSAGE[inject])}</p>
            )}
          </>
        ) : null}
        <button type="button" className="button button--primary" onClick={openReader}>
          {t('popupOpenReader')}
        </button>
        <button type="button" className="button" onClick={openSettings}>
          {t('popupSettings')}
        </button>
      </div>
    </Page>
  );
}
