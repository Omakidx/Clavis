import { useState } from 'react';
import { browser } from 'wxt/browser';
import { Button, ErrorNotice } from '../../components/common/ui';
import { Page } from '../../components/common/Page';
import { t } from '../../lib/i18n';
import { injectTabMessage, type InjectResult } from '../../lib/site-access/messages';
import { useSiteAccess } from '../../lib/site-access/use-site-access';
import { api } from '../../lib/ui-client/api';
import { openExtensionPage, openSettingsPage } from '../../lib/ui-client/navigation';
import { useResource } from '../../lib/ui-client/use-resource';
import { GROQ_STATUS } from './status';

function openReader() {
  openExtensionPage('/reader.html');
  window.close();
}

function openSettings() {
  openSettingsPage();
  window.close();
}

function openSetup() {
  openExtensionPage('/onboarding.html');
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

/** Compact status: is Groq ready, is website access on, and the buttons people need most. */
export function App() {
  const { status } = useSiteAccess();
  const ai = useResource(api.getAiStatus);
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

  const aiState = ai.state;
  const groq = aiState.status === 'ready' ? GROQ_STATUS[aiState.data.state] : null;

  return (
    <Page title={t('extName')} size="narrow">
      <dl className="clavis-facts" aria-label={t('popupStatusLabel')} data-testid="popup-status">
        <dt>{t('popupGroqLabel')}</dt>
        <dd data-testid="popup-groq">
          {aiState.status === 'loading' ? (
            t('popupGroqChecking')
          ) : groq === null ? (
            t('popupGroqUnknown')
          ) : (
            <span className={`clavis-badge clavis-badge--${groq.tone}`}>{t(groq.text)}</span>
          )}
        </dd>
        <dt>{t('popupSiteLabel')}</dt>
        <dd data-testid="popup-site">
          {status === 'unknown'
            ? t('popupSiteChecking')
            : status === 'granted'
              ? t('popupSiteOn')
              : t('popupSiteOff')}
        </dd>
      </dl>

      {aiState.status === 'error' ? (
        <ErrorNotice error={aiState.error} onRetry={ai.reload} onOpenSettings={openSettings} />
      ) : null}

      <div className="clavis-actions">
        {groq?.action === 'connect' ? (
          <Button variant="primary" onClick={openSettings}>
            {t('uiConnectGroq')}
          </Button>
        ) : null}
        {groq?.action === 'update-key' ? (
          <Button variant="primary" onClick={openSettings}>
            {t('uiUpdateKey')}
          </Button>
        ) : null}
        {groq?.action === 'review' ? (
          <Button variant="primary" onClick={openSetup}>
            {t('popupReviewSetup')}
          </Button>
        ) : null}
        {status === 'not-granted' ? (
          <>
            <Button
              variant={groq === null || groq.action === 'none' ? 'primary' : 'default'}
              disabled={inject === 'busy'}
              onClick={onExplainHere}
            >
              {t('popupInjectButton')}
            </Button>
            <p className="clavis-muted">{t('popupInjectHint')}</p>
            <div className="clavis-live" role="status">
              {inject === 'idle' || inject === 'busy' ? null : <p>{t(INJECT_MESSAGE[inject])}</p>}
            </div>
          </>
        ) : null}
        <Button
          variant={groq?.action === 'none' || groq === null ? 'primary' : 'default'}
          onClick={openReader}
        >
          {t('popupOpenReader')}
        </Button>
        <Button onClick={openSettings}>{t('popupSettings')}</Button>
      </div>
    </Page>
  );
}
