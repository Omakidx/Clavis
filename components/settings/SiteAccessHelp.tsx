import { t } from '../../lib/i18n';

interface SiteAccessHelpProps {
  /** Leave the heading out when the caller already labels the block (the popup's expandable help). */
  bare?: boolean;
}

/**
 * Help for people who did not allow website access (FR-018, R-05): the three ways to use Clavis
 * on the current page, and how to turn the automatic toolbar on. Shown in Settings (Website
 * access and Help), at the end of onboarding when declined, and in the popup when access is off.
 */
export function SiteAccessHelp({ bare = false }: SiteAccessHelpProps) {
  // Bare (the popup): the block sits straight under the page's h1, so its one heading is an h2.
  const Sub = bare ? 'h2' : 'h4';
  return (
    <div className="clavis-help" data-testid="site-access-help">
      {bare ? null : <h3>{t('siteHelpTitle')}</h3>}
      <p>{t('siteHelpIntro')}</p>
      <ul>
        <li>{t('siteHelpContextMenu')}</li>
        <li>{t('siteHelpIcon')}</li>
        <li>{t('siteHelpShortcut')}</li>
      </ul>
      <Sub className="clavis-help__sub">{t('siteHelpTurnOnTitle')}</Sub>
      <p>{t('siteHelpTurnOn')}</p>
      <p>{t('siteHelpToolbarSetting')}</p>
    </div>
  );
}
