import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { t } from '../../lib/i18n';
import type { ClientError } from '../../lib/ui-client/errors';
import { checkNewSite } from '../../lib/ui-client/hostnames';
import { openSettingsPage } from '../../lib/ui-client/navigation';
import type { ClientResult } from '../../lib/ui-client/request';
import { Button, ErrorNotice, LiveStatus } from '../common/ui';

interface DisabledSitesProps {
  sites: readonly string[];
  /** Persist the whole new list. */
  save(sites: string[]): Promise<ClientResult<unknown>>;
}

const PROBLEM_TEXT = {
  empty: 'siteDisabledErrEmpty',
  invalid: 'siteDisabledErrInvalid',
  limit: 'siteDisabledErrLimit',
} as const;

/** Per-site disable list: add a hostname (validated and normalized) or remove one. */
export function DisabledSites({ sites, save }: DisabledSitesProps) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [busy, setBusy] = useState(false);

  async function persist(next: string[], done: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await save(next);
    setBusy(false);
    if (result.ok) {
      setMessage(done);
      return true;
    }
    setError(result.error);
    return false;
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const check = checkNewSite(draft, sites);
    if (!check.ok) {
      setProblem(
        check.reason === 'duplicate'
          ? t('siteDisabledErrDuplicate', normalizeForMessage(draft))
          : t(PROBLEM_TEXT[check.reason]),
      );
      inputRef.current?.focus();
      return;
    }
    setProblem(null);
    if (await persist([...sites, check.host], t('siteDisabledAdded', check.host))) setDraft('');
    inputRef.current?.focus();
  }

  async function remove(host: string) {
    await persist(
      sites.filter((site) => site !== host),
      t('siteDisabledRemoved', host),
    );
    // The removed row's button is gone; hand focus back to the input.
    inputRef.current?.focus();
  }

  return (
    <div className="clavis-stack">
      <h3>{t('siteDisabledTitle')}</h3>
      <p>{t('siteDisabledIntro')}</p>
      <p className="clavis-hint">{t('settingsReloadNote')}</p>

      <form onSubmit={(event) => void add(event)} noValidate>
        <div className="clavis-field">
          <label className="clavis-label" htmlFor={inputId}>
            {t('siteDisabledLabel')}
          </label>
          <div className="clavis-input-row">
            <input
              id={inputId}
              ref={inputRef}
              className="clavis-input"
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-describedby={`${hintId}${problem ? ` ${errorId}` : ''}`}
              aria-invalid={problem ? true : undefined}
            />
            <Button type="submit" disabled={busy}>
              {t('siteDisabledAdd')}
            </Button>
          </div>
          <p id={hintId} className="clavis-hint">
            {t('siteDisabledHint')}
          </p>
          {problem ? (
            <p id={errorId} className="clavis-error" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      </form>

      {sites.length === 0 ? (
        <p className="clavis-muted">{t('siteDisabledEmpty')}</p>
      ) : (
        <ul aria-label={t('siteDisabledListLabel')} data-testid="disabled-sites">
          {sites.map((host) => (
            <li key={host} className="clavis-site-row">
              <span className="clavis-site-row__host" dir="auto">
                {host}
              </span>
              <Button
                disabled={busy}
                aria-label={t('siteDisabledRemove', host)}
                onClick={() => void remove(host)}
              >
                {t('siteDisabledRemoveShort')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <LiveStatus message={message} tone="success" />
      {error ? <ErrorNotice error={error} onOpenSettings={openSettingsPage} /> : null}
    </div>
  );
}

/** What the user typed, trimmed, for the "already on the list" message. */
function normalizeForMessage(raw: string): string {
  return raw.trim().toLowerCase();
}
