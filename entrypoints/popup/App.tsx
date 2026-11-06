import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { Button, ErrorNotice, LiveStatus, Notice } from '../../components/common/ui';
import { Page } from '../../components/common/Page';
import { SiteAccessHelp } from '../../components/settings/SiteAccessHelp';
import { t } from '../../lib/i18n';
import { injectTabMessage, type InjectResult } from '../../lib/site-access/messages';
import { useSiteAccess } from '../../lib/site-access/use-site-access';
import { api } from '../../lib/ui-client/api';
import {
  openExtensionPage,
  openSettingsAt,
  openSettingsPage,
} from '../../lib/ui-client/navigation';
import { useResource } from '../../lib/ui-client/use-resource';
import { GROQ_STATUS, isPdfTabUrl } from './status';
import './popup.css';

function openReader() {
  openExtensionPage('/reader.html');
  window.close();
}

function openSettings() {
  openSettingsPage();
  window.close();
}

/** Settings at one section; the popup closes because the page it opens takes over. */
function openSection(section: Parameters<typeof openSettingsAt>[0]) {
  openSettingsAt(section);
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

/** Address of the tab the popup was opened on (readable under `activeTab`), when it can be read. */
function useActiveTabUrl(): string | undefined {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    browser.tabs.query({ active: true, currentWindow: true }).then(
      ([tab]) => {
        if (alive) setUrl(tab?.url);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return url;
}

/**
 * Compact status: is Groq ready, is website access on, and the buttons people need most. What
 * is not working says so here and has one button that fixes it (no key, key rejected), a tab
 * that is a PDF in Chrome's own viewer points to the Clavis reader, and without website access
 * the other ways to use Clavis are one click away.
 */
export function App() {
  const { status } = useSiteAccess();
  const ai = useResource(api.getAiStatus);
  const [inject, setInject] = useState<InjectState>('idle');
  const injecting = useRef(false);
  const onPdfTab = isPdfTabUrl(useActiveTabUrl());

  function onExplainHere() {
    if (injecting.current) return;
    injecting.current = true;
    setInject('busy');
    explainOnThisPage().then(
      (next) => {
        injecting.current = false;
        setInject(next);
        if (next === 'idle') window.close();
      },
      () => {
        injecting.current = false;
        setInject('failed');
      },
    );
  }

  const aiState = ai.state;
  const groq = aiState.status === 'ready' ? GROQ_STATUS[aiState.data.state] : null;
  const fixVariant = onPdfTab ? 'default' : 'primary';
  const fixAction =
    groq?.action === 'connect' ? (
      <Button variant={fixVariant} onClick={() => openSection('key')}>
        {t('uiConnectGroq')}
      </Button>
    ) : groq?.action === 'update-key' ? (
      <Button variant={fixVariant} onClick={() => openSection('key')}>
        {t('uiUpdateKey')}
      </Button>
    ) : groq?.action === 'review' ? (
      <Button variant={fixVariant} onClick={openSetup}>
        {t('popupReviewSetup')}
      </Button>
    ) : null;

  return (
    <Page title={t('extName')} size="narrow">
      <div className="clavis-popup">
        <section className="clavis-popup__actions" aria-label={t('popupActionsLabel')}>
          {onPdfTab ? (
            <Button variant="primary" onClick={openReader}>
              {t('popupOpenReader')}
            </Button>
          ) : (
            <>
              {fixAction}
              <Button
                variant={fixAction === null ? 'primary' : 'default'}
                disabled={inject === 'busy'}
                onClick={onExplainHere}
              >
                {inject === 'busy' ? t('popupInjectBusy') : t('popupInjectButton')}
              </Button>
              <Button onClick={openReader}>{t('popupOpenReader')}</Button>
            </>
          )}
          {onPdfTab ? fixAction : null}
          {onPdfTab ? null : <p className="clavis-popup__hint">{t('popupInjectHint')}</p>}
        </section>

        <LiveStatus
          message={
            inject === 'idle'
              ? null
              : t(inject === 'busy' ? 'popupInjectBusy' : INJECT_MESSAGE[inject])
          }
          tone={inject === 'busy' ? 'info' : 'warning'}
        />

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

        {groq !== null && groq.notice.length > 0 ? (
          <Notice tone={groq.tone === 'danger' ? 'danger' : 'warning'}>
            {groq.notice.map((key) => (
              <p key={key}>{t(key)}</p>
            ))}
          </Notice>
        ) : null}

        {onPdfTab ? (
          <Notice testId="popup-pdf-help">
            <h2 className="clavis-notice__title">{t('popupPdfTitle')}</h2>
            <p>{t('popupPdfBody')}</p>
            <Button variant="link" onClick={() => openSection('pdfHelp')}>
              {t('popupPdfHelp')}
            </Button>
          </Notice>
        ) : null}

        {status === 'not-granted' ? (
          <details className="clavis-disclosure" data-testid="popup-site-help">
            <summary>{t('siteHelpTitle')}</summary>
            <SiteAccessHelp bare />
            <div className="clavis-actions">
              <Button onClick={() => openSection('site')}>{t('siteHelpOpenSettings')}</Button>
            </div>
          </details>
        ) : null}

        <footer className="clavis-popup__footer">
          <Button variant="link" onClick={openSettings}>
            {t('popupSettings')}
          </Button>
        </footer>
      </div>
    </Page>
  );
}
